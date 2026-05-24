import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDatabase } from './db.js';
import { listTreasuryAccounts } from './readModel.js';

describe('treasury accounts per branch', () => {
  beforeAll(() => {
    process.env.ZAREWA_EMPTY_SEED = '1';
  });
  afterAll(() => {
    delete process.env.ZAREWA_EMPTY_SEED;
  });

  it('listTreasuryAccounts filters by workspace branch scope', () => {
    const db = createDatabase(':memory:');
    try {
      db.prepare(
        `INSERT INTO treasury_accounts (name, bank_name, balance, type, acc_no, branch_id)
         VALUES ('Yola Main', 'GTBank', 1000, 'Bank', '111', 'BR-YL'),
                ('Maiduguri Till', '', 500, 'Cash', 'N/A', 'BR-MDG')`
      ).run();

      const yola = listTreasuryAccounts(db, 'BR-YL');
      const mdg = listTreasuryAccounts(db, 'BR-MDG');
      const all = listTreasuryAccounts(db, 'ALL');

      expect(yola).toHaveLength(1);
      expect(yola[0].name).toBe('Yola Main');
      expect(yola[0].branchId).toBe('BR-YL');

      expect(mdg).toHaveLength(1);
      expect(mdg[0].name).toBe('Maiduguri Till');
      expect(mdg[0].branchId).toBe('BR-MDG');

      expect(all).toHaveLength(2);
    } finally {
      db.close();
    }
  });
});
