import { describe, it, expect, vi } from 'vitest';
import { withDeadlockRetry, withMigrationLock } from './migrationLock.js';

describe('migrationLock', () => {
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

  it('withMigrationLock acquires and releases GET_LOCK', () => {
    const run = vi.fn();
    const get = vi.fn(() => ({ got: 1 }));
    const db = {
      prepare(sql) {
        const s = String(sql);
        if (s.includes('GET_LOCK')) return { get };
        if (s.includes('RELEASE_LOCK')) return { run };
        throw new Error(`unexpected sql: ${s}`);
      },
    };
    const out = withMigrationLock(db, () => 'done');
    expect(out).toBe('done');
    expect(get).toHaveBeenCalled();
    expect(run).toHaveBeenCalled();
  });
});
