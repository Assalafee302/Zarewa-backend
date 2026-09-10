import { describe, it, expect } from 'vitest';
import { batchInsertValues, batchRunSameSql } from './dbBatchInsert.js';

/** Records every statement so a test can assert batching shape, not just the total. */
function stubDb({ changesPerRun = null, withRunMany = false } = {}) {
  const runs = [];
  const db = {
    prepare(sql) {
      return {
        run: (...args) => {
          runs.push({ sql, args });
          return changesPerRun == null ? { changes: args.length } : { changes: changesPerRun };
        },
      };
    },
    runs,
  };
  if (withRunMany) {
    db.runMany = (statements) => {
      runs.push({ runMany: statements.length });
      return changesPerRun == null ? { changes: statements.length } : { changes: changesPerRun };
    };
  }
  return db;
}

describe('batchInsertValues', () => {
  const PREFIX = 'INSERT INTO ledger_entries (a, b)';

  it('collapses rows into one multi-value statement per batch', () => {
    const db = stubDb();
    const res = batchInsertValues(db, PREFIX, 2, [
      [1, 2],
      [3, 4],
      [5, 6],
    ]);
    expect(db.runs).toHaveLength(1);
    expect(db.runs[0].sql).toBe(`${PREFIX} VALUES (?,?),(?,?),(?,?)`);
    expect(db.runs[0].args).toEqual([1, 2, 3, 4, 5, 6]);
    expect(res.rows).toBe(3);
    expect(res.batches).toBe(1);
  });

  it('splits at batchSize', () => {
    const db = stubDb();
    const rows = Array.from({ length: 5 }, (_, i) => [i, i]);
    const res = batchInsertValues(db, PREFIX, 2, rows, { batchSize: 2 });
    expect(res.batches).toBe(3);
    expect(db.runs.map((r) => r.args.length)).toEqual([4, 4, 2]);
  });

  it('throws on an arity mismatch instead of dropping the row', () => {
    // The row would otherwise vanish from a money table with no error at all.
    const db = stubDb();
    expect(() =>
      batchInsertValues(db, PREFIX, 2, [
        [1, 2],
        [3],
        [5, 6],
      ])
    ).toThrow(/row 1 has 1 args, expected 2/);
    expect(db.runs).toHaveLength(0);
  });

  it('throws when a row is not an array at all', () => {
    expect(() => batchInsertValues(stubDb(), PREFIX, 2, [{ a: 1, b: 2 }])).toThrow(
      /row 0 has object args, expected 2/
    );
  });

  it('reports a genuine zero rather than assuming the batch applied', () => {
    // A driver reporting 0 affected rows means nothing was written; saying otherwise
    // would hide a failed batch from every caller.
    const db = stubDb({ changesPerRun: 0 });
    expect(batchInsertValues(db, PREFIX, 2, [[1, 2]]).changes).toBe(0);
  });

  it('is a no-op on an empty list', () => {
    const db = stubDb();
    expect(batchInsertValues(db, PREFIX, 2, [])).toEqual({ changes: 0, batches: 0, rows: 0 });
    expect(db.runs).toHaveLength(0);
  });
});

describe('batchRunSameSql', () => {
  const SQL = 'UPDATE t SET x = ? WHERE id = ?';

  it('uses runMany in batches when the driver offers it', () => {
    const db = stubDb({ withRunMany: true });
    const res = batchRunSameSql(db, SQL, [
      [1, 'a'],
      [2, 'b'],
      [3, 'c'],
    ], { batchSize: 2 });
    expect(db.runs).toEqual([{ runMany: 2 }, { runMany: 1 }]);
    expect(res.batches).toBe(2);
    expect(res.rows).toBe(3);
  });

  it('falls back to one prepared statement per row without runMany', () => {
    const db = stubDb();
    const res = batchRunSameSql(db, SQL, [
      [1, 'a'],
      [2, 'b'],
    ]);
    expect(db.runs).toHaveLength(2);
    expect(res.rows).toBe(2);
  });

  it('reports a genuine zero on the runMany path too', () => {
    const db = stubDb({ withRunMany: true, changesPerRun: 0 });
    expect(batchRunSameSql(db, SQL, [[1, 'a']]).changes).toBe(0);
  });
});
