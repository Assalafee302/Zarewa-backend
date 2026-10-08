import { describe, it, expect, vi } from 'vitest';
import {
  withDeadlockRetry,
  withMigrationLock,
  defaultMigrationLockWaitSec,
  migrationLockNameForDatabase,
} from './migrationLock.js';
import { lockAcquireFailureMessage } from './mysqlNamedLock.js';

describe('migrationLock', () => {
  it('defaultMigrationLockWaitSec is 120s under test', () => {
    expect(defaultMigrationLockWaitSec()).toBe(120);
  });
  it('withDeadlockRetry succeeds after a deadlock', () => {
    const fn = vi
      .fn()
      .mockImplementationOnce(() => {
        const err = new Error('Deadlock found when trying to get lock; try restarting transaction');
        err.errno = 1213;
        throw err;
      })
      .mockImplementationOnce(() => 'ok');
    expect(withDeadlockRetry(fn)).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('migrationLockNameForDatabase is unique per schema', () => {
    expect(migrationLockNameForDatabase('zarewa_test_w1')).toBe('zarewa_mig_zarewa_test_w1');
    expect(migrationLockNameForDatabase('zarewa_test_w2')).not.toBe(
      migrationLockNameForDatabase('zarewa_test_w1')
    );
    expect(migrationLockNameForDatabase('')).toBe('zarewa_run_migrations');
  });

  it('withMigrationLock acquires and releases GET_LOCK', () => {
    const run = vi.fn();
    const get = vi.fn(() => ({ got: 1 }));
    const db = {
      prepare(sql) {
        const s = String(sql);
        if (s.includes('DATABASE()')) return { get: () => ({ n: 'zarewa_test_w1' }) };
        if (s.includes('GET_LOCK')) return { get };
        if (s.includes('RELEASE_LOCK')) return { run };
        throw new Error(`unexpected sql: ${s}`);
      },
    };
    const out = withMigrationLock(db, () => 'done');
    expect(out).toBe('done');
    expect(get).toHaveBeenCalledWith('zarewa_mig_zarewa_test_w1', expect.any(Number));
    expect(run).toHaveBeenCalledWith('zarewa_mig_zarewa_test_w1');
  });

  it('withMigrationLock logs dead holder id when processlist miss', () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const db = {
      prepare(sql) {
        const s = String(sql);
        if (s.includes('DATABASE()')) return { get: () => ({ n: 'u172282559_ZAREWA' }) };
        if (s.includes('GET_LOCK')) return { get: () => ({ got: 0 }) };
        if (s.includes('IS_USED_LOCK')) return { get: () => ({ holderConnId: 4242 }) };
        if (s.includes('processlist')) return { get: () => undefined };
        throw new Error(`unexpected sql: ${s}`);
      },
    };
    expect(() => withMigrationLock(db, () => 'nope')).toThrow(/dead\/orphaned connection|id=4242/);
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining('dead/orphan lock holder id=4242')
    );
    errSpy.mockRestore();
  });

  it('lockAcquireFailureMessage distinguishes live vs dead holder', () => {
    const dead = lockAcquireFailureMessage(
      'zarewa_mig_x',
      120,
      { holderConnId: 9, process: null },
      'schema'
    );
    expect(dead).toMatch(/schema lock/);
    expect(dead).toMatch(/id=9/);
    expect(dead).toMatch(/NOT in processlist/);

    const live = lockAcquireFailureMessage(
      'zarewa_mig_x',
      120,
      {
        holderConnId: 9,
        process: {
          id: 9,
          user: 'u1',
          host: 'localhost',
          db: 'zarewa',
          command: 'Sleep',
          time: 30,
          state: '',
          info: null,
        },
      },
      'schema'
    );
    expect(live).toMatch(/Held by connection id=9/);
    expect(live).toMatch(/Stop the old API process/);
  });
});
