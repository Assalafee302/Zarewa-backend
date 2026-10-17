import { describe, it, expect } from 'vitest';
import { reconcileTreasuryBalances } from './dbIntegrityMigrate.js';

/** Fake db answering like MySQL: SUM() comes back as a DECIMAL string. */
function mysqlLikeDb(sumText) {
  const writes = [];
  return {
    writes,
    prepare(sql) {
      return {
        get: () => {
          if (/sqlite_master/i.test(sql)) return { 1: 1 };
          if (/COUNT\(\*\)/i.test(sql)) return { c: 3 };
          return { s: sumText };
        },
        all: () => [{ id: 2 }],
        run: (...args) => writes.push({ sql, args }),
      };
    },
  };
}

describe('reconcileTreasuryBalances with MySQL string SUM', () => {
  it('writes the balance as a number', () => {
    const db = mysqlLikeDb('21401720');
    reconcileTreasuryBalances(db);
    expect(db.writes).toHaveLength(1);
    expect(db.writes[0].args).toEqual([21_401_720, 2]);
    expect(typeof db.writes[0].args[0]).toBe('number');
  });
});
