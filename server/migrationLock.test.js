import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { withMigrationLock } from './migrationLock.js';

/**
 * Stub of the sync db facade: records every statement + args so we can assert how long
 * a single GET_LOCK call is allowed to block.
 */
function stubDb({ acquireOnAttempt = 1 } = {}) {
  const calls = [];
  let attempts = 0;
  return {
    calls,
    get attempts() {
      return attempts;
    },
    prepare(sql) {
      return {
        get: (...args) => {
          calls.push({ sql, args });
          if (/SELECT DATABASE\(\)/i.test(sql)) return { n: 'zarewa_db' };
          if (/GET_LOCK/i.test(sql)) {
            attempts += 1;
            return { got: attempts >= acquireOnAttempt ? 1 : 0 };
          }
          return {};
        },
        run: (...args) => {
          calls.push({ sql, args });
          return {};
        },
      };
    },
  };
}

const ENV_KEYS = ['ZAREWA_MYSQL_SYNC_TIMEOUT_MS', 'ZAREWA_MIGRATION_LOCK_WAIT_SEC', 'NODE_ENV', 'VITEST'];
let saved;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  // Emulate a serving worker: 10s sync channel, long overall willingness to wait.
  process.env.ZAREWA_MYSQL_SYNC_TIMEOUT_MS = '10000';
  process.env.ZAREWA_MIGRATION_LOCK_WAIT_SEC = '1200';
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('withMigrationLock', () => {
  it('never asks GET_LOCK to block longer than the synckit channel allows', () => {
    const db = stubDb();
    withMigrationLock(db, () => {});
    const lockCalls = db.calls.filter((c) => /GET_LOCK/i.test(c.sql));
    expect(lockCalls.length).toBeGreaterThan(0);
    for (const call of lockCalls) {
      const waitSec = call.args[1];
      // 10s channel → slices of 5s. A 1200s ask would be killed by synckit and the
      // worker would die instead of queueing behind the instance that is migrating.
      expect(waitSec).toBeLessThanOrEqual(5);
      expect(waitSec * 1000).toBeLessThan(Number(process.env.ZAREWA_MYSQL_SYNC_TIMEOUT_MS));
    }
  });

  it('keeps re-asking until the lock frees up, then runs the migration once', () => {
    const db = stubDb({ acquireOnAttempt: 4 });
    let ran = 0;
    withMigrationLock(db, () => {
      ran += 1;
    });
    expect(db.attempts).toBe(4);
    expect(ran).toBe(1);
  });

  it('releases the lock afterwards', () => {
    const db = stubDb();
    withMigrationLock(db, () => {});
    expect(db.calls.some((c) => /RELEASE_LOCK/i.test(c.sql))).toBe(true);
  });

  it('gives up with a clear error once the overall deadline passes', () => {
    process.env.ZAREWA_MIGRATION_LOCK_WAIT_SEC = '1';
    const db = stubDb({ acquireOnAttempt: Number.MAX_SAFE_INTEGER });
    expect(() => withMigrationLock(db, () => {})).toThrow(/Could not acquire migration lock/);
  });

  it('does not release a lock it never acquired', () => {
    process.env.ZAREWA_MIGRATION_LOCK_WAIT_SEC = '1';
    const db = stubDb({ acquireOnAttempt: Number.MAX_SAFE_INTEGER });
    expect(() => withMigrationLock(db, () => {})).toThrow();
    expect(db.calls.some((c) => /RELEASE_LOCK/i.test(c.sql))).toBe(false);
  });
});
