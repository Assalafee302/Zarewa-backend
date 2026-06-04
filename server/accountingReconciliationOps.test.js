import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import {
  buildFinanceReconciliationPackEnvelope,
  getCashFlowPack,
  getReconciliationPack,
  isValidFinancePackPeriodKey,
} from './accountingReconciliationOps.js';

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

describe('accountingReconciliationOps (pure)', () => {
  it('isValidFinancePackPeriodKey accepts YYYY-MM only', () => {
    expect(isValidFinancePackPeriodKey('2026-05')).toBe(true);
    expect(isValidFinancePackPeriodKey('bad')).toBe(false);
    expect(isValidFinancePackPeriodKey('')).toBe(false);
  });

  it('buildFinanceReconciliationPackEnvelope includes management labels and ownership', () => {
    const pack = {
      ok: true,
      periodKey: '2026-04',
      range: { start: '2026-04-01', end: '2026-04-30' },
      branchScope: 'BR-KD',
      salesReceiptsPostedNgn: 100,
      ledgerReceiptLikeNgn: 90,
      treasuryCustomerInNgn: 100,
      glCash1000Month: { accountCode: '1000', netNgn: 50 },
      glAr1200Month: { accountCode: '1200', netNgn: 10 },
      note: 'Test note',
    };
    const cashFlowSummary = {
      ok: true,
      periodKey: '2026-04',
      rows: [{ type: 'RECEIPT_IN', totalNgn: 100 }],
      netTreasuryMovementNgn: 100,
      note: 'CF note',
    };
    const body = buildFinanceReconciliationPackEnvelope({
      pack,
      cashFlowSummary,
      periodKey: '2026-04',
      branchScope: 'BR-KD',
    });
    expect(body.ok).toBe(true);
    expect(body.status).toBe('management_draft');
    expect(body.label).toMatch(/Finance reconciliation and cash confirmation pack/i);
    expect(body.disclaimer).toMatch(/not statutory/i);
    expect(body.cashConfirmationBasis).toMatch(/Receipt confirmation/i);
    expect(body.formalBankReconciliationStatus).toMatch(/Partial/i);
    expect(body.departmentOwnership?.accounting).toMatch(/Head of Accounts/i);
    expect(body.departmentOwnership?.cashier).toMatch(/Cashier/i);
    expect(body.departmentOwnership?.audit).toMatch(/MD/i);
    expect(body.branchScope).toBe('BR-KD');
    expect(body.tieOutSections.length).toBeGreaterThan(0);
    const reviewNote = (body.notes || []).find((n) => n.code === 'head_of_accounts_review');
    expect(reviewNote?.message).toMatch(/Head of Accounts/i);
    const bankNote = (body.notes || []).find((n) => n.code === 'formal_bank_reconciliation_pending');
    expect(bankNote?.message).toMatch(/bank/i);
  });
});

describe.skipIf(!mysqlOk)('accountingReconciliationOps (database)', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
  });

  afterEach(() => {
    db?.close();
  });

  it('getReconciliationPack returns ok for valid period', () => {
    const p = getReconciliationPack(db, '2026-01', 'ALL');
    expect(p.ok).toBe(true);
    expect(p.periodKey).toBe('2026-01');
    expect(p.branchScope).toBe('ALL');
    expect(typeof p.salesReceiptsPostedNgn).toBe('number');
    expect(p.glCash1000Month).toBeDefined();
    expect(p.glAr1200Month).toBeDefined();
  });

  it('getReconciliationPack returns error for invalid period', () => {
    const p = getReconciliationPack(db, 'not-a-period', 'ALL');
    expect(p.ok).toBe(false);
    expect(String(p.error || '')).toMatch(/YYYY-MM/i);
  });

  it('getReconciliationPack preserves branch scope', () => {
    const p = getReconciliationPack(db, '2026-03', 'BR-YL');
    expect(p.ok).toBe(true);
    expect(p.branchScope).toBe('BR-YL');
  });

  it('getCashFlowPack returns ok for valid period', () => {
    const c = getCashFlowPack(db, '2026-02');
    expect(c.ok).toBe(true);
    expect(Array.isArray(c.rows)).toBe(true);
  });
});
