import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import { postBalancedJournal, trialBalanceRows } from './glOps.js';

function mysqlAvailable() {
  try {
    const db = createDatabase(':memory:', { seed: false });
    db.close();
    return true;
  } catch {
    return false;
  }
}

const mysqlOk = mysqlAvailable();

describe.skipIf(!mysqlOk)('GL branch scope', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
  });

  afterEach(() => {
    db?.close();
  });

  it('trialBalanceRows filters journal activity by branch_id', () => {
    const base = {
      entryDateISO: '2026-06-15',
      sourceKind: 'TEST_GL_BRANCH',
      lines: [
        { accountCode: '1001', debitNgn: 50_000, memo: 'Cash in' },
        { accountCode: '3100', creditNgn: 50_000, memo: 'Capital' },
      ],
    };
    const kd = postBalancedJournal(db, { ...base, sourceId: 'KD-1', branchId: 'BR-KD', memo: 'Kaduna test' });
    const yl = postBalancedJournal(db, { ...base, sourceId: 'YL-1', branchId: 'BR-YL', memo: 'Yola test' });
    expect(kd.ok).toBe(true);
    expect(yl.ok).toBe(true);

    const kdTb = trialBalanceRows(db, '2026-06-01', '2026-06-30', { branchScope: 'BR-KD' });
    const ylTb = trialBalanceRows(db, '2026-06-01', '2026-06-30', { branchScope: 'BR-YL' });
    const allTb = trialBalanceRows(db, '2026-06-01', '2026-06-30', { branchScope: 'ALL' });

    expect(kdTb.ok).toBe(true);
    expect(ylTb.ok).toBe(true);
    expect(allTb.ok).toBe(true);

    const kdCash = kdTb.rows.find((r) => r.accountCode === '1001');
    const ylCash = ylTb.rows.find((r) => r.accountCode === '1001');
    const allCash = allTb.rows.find((r) => r.accountCode === '1001');

    expect(kdCash?.debitNgn).toBe(50_000);
    expect(ylCash?.debitNgn).toBe(50_000);
    expect(allCash?.debitNgn).toBe(100_000);
  });
});
