import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDatabase } from './db.js';
import { runMigrations } from './migrate.js';
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

  it('migration backfills legacy treasury accounts to Kaduna HQ (BR-KD)', () => {
    const db = createDatabase(':memory:');
    try {
      db.prepare(
        `INSERT INTO treasury_accounts (name, bank_name, balance, type, acc_no, branch_id)
         VALUES ('MoneyPoint', 'MoneyPoint', 100, 'Bank', 'MP1', 'BR-YL'),
                ('TAJ Bank', 'TAJ', 200, 'Bank', 'TAJ1', 'BR-YL'),
                ('Cash Office', '', 50, 'Cash', 'N/A', 'BR-YL')`
      ).run();
      runMigrations(db);
      const kd = listTreasuryAccounts(db, 'BR-KD');
      const yl = listTreasuryAccounts(db, 'BR-YL');
      expect(kd).toHaveLength(3);
      expect(yl).toHaveLength(0);
      expect(kd.map((a) => a.name).sort()).toEqual(['Cash Office', 'MoneyPoint', 'TAJ Bank']);
    } finally {
      db.close();
    }
  });
});
