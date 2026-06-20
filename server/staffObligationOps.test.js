import { beforeAll, describe, expect, it } from 'vitest';
import { acquireIntegrationHarness, isMysqlAvailableForTests, resolveTestActor } from './testIntegrationHarness.js';
import {
  activeObligationBreakdownForPayroll,
  chairmanWaiveObligationBalance,
  getStaffObligationAccountDetail,
  migrateLegacyStaffLoan,
  patchObligationDeductionPause,
  recordObligationCashRepayment,
  staffObligationTablesReady,
} from './staffObligationOps.js';
import { getStaffLoanSchedule } from './hrLoanSchedule.js';

describe.skipIf(!isMysqlAvailableForTests())('staffObligationOps', () => {
  let db;
  let actor;
  let staffUserId;

  beforeAll(() => {
    const harness = acquireIntegrationHarness();
    db = harness.db;
    actor = resolveTestActor(db);
    const staff = db.prepare(`SELECT user_id FROM hr_staff_profiles LIMIT 1`).get();
    staffUserId = staff?.user_id;
    expect(staffUserId).toBeTruthy();
    expect(staffObligationTablesReady(db)).toBe(true);
  });

  it('registers legacy loan with opening balance and prior repayments', () => {
    const r = migrateLegacyStaffLoan(db, actor, {
      userId: staffUserId,
      principalOriginalNgn: 500_000,
      amountRepaidNgn: 200_000,
      installmentNgn: 50_000,
      termMonths: 6,
      title: 'Pre-ERP staff loan',
      note: 'UAT legacy register',
    });
    expect(r.ok).toBe(true);
    expect(r.account.principalOriginalNgn).toBe(500_000);
    expect(r.account.principalOutstandingNgn).toBe(300_000);
    expect(r.account.status).toBe('active');

    const detail = getStaffObligationAccountDetail(db, r.account.id);
    expect(detail.transactions.length).toBeGreaterThanOrEqual(2);
  });

  it('records partial cash repayment with receipt reference', () => {
    const created = migrateLegacyStaffLoan(db, actor, {
      userId: staffUserId,
      principalOriginalNgn: 100_000,
      amountRepaidNgn: 0,
      installmentNgn: 25_000,
      termMonths: 4,
      title: 'Cash repay test loan',
    });
    expect(created.ok).toBe(true);

    const pay = recordObligationCashRepayment(db, actor, created.account.id, {
      amountNgn: 40_000,
      paymentReference: 'TEST-BANK-REF-001',
      note: 'Bulk bank transfer',
    });
    expect(pay.ok).toBe(true);
    expect(pay.receiptReference).toBeTruthy();
    expect(pay.account.principalOutstandingNgn).toBe(60_000);
  });

  it('exposes active payroll breakdown and schedule view', () => {
    migrateLegacyStaffLoan(db, actor, {
      userId: staffUserId,
      principalOriginalNgn: 80_000,
      installmentNgn: 20_000,
      termMonths: 4,
      title: 'Payroll breakdown loan',
    });
    const breakdown = activeObligationBreakdownForPayroll(db, staffUserId);
    expect(breakdown).toBeTruthy();
    expect(breakdown.total).toBeGreaterThan(0);
    expect(breakdown.items[0].obligationAccountId).toBeTruthy();

    const schedule = getStaffLoanSchedule(db, staffUserId);
    expect(schedule.some((s) => s.outstandingNgn > 0)).toBe(true);
  });

  it('records cashier payment with treasury and optional installment recalc', () => {
    const staff = db.prepare(`SELECT branch_id FROM hr_staff_profiles WHERE user_id = ?`).get(staffUserId);
    const branchId = staff?.branch_id || 'KD';
    const ta = db
      .prepare(`SELECT id FROM treasury_accounts WHERE branch_id = ? OR branch_id IS NULL ORDER BY id LIMIT 1`)
      .get(branchId);
    expect(ta?.id).toBeTruthy();

    const created = migrateLegacyStaffLoan(db, actor, {
      userId: staffUserId,
      principalOriginalNgn: 120_000,
      amountRepaidNgn: 0,
      installmentNgn: 30_000,
      termMonths: 4,
      title: 'Treasury cashier loan',
    });
    expect(created.ok).toBe(true);

    const beforeBal = db.prepare(`SELECT balance FROM treasury_accounts WHERE id = ?`).get(ta.id)?.balance;
    const pay = recordObligationCashRepayment(db, actor, created.account.id, {
      treasuryAccountId: ta.id,
      requireTreasury: true,
      amountNgn: 60_000,
      paymentDateIso: new Date().toISOString().slice(0, 10),
      recalculateInstallment: true,
      workspaceBranchId: branchId,
      workspaceViewAll: false,
    });
    expect(pay.ok).toBe(true);
    expect(pay.treasuryMovementId).toBeTruthy();
    expect(pay.account.principalOutstandingNgn).toBe(60_000);
    expect(pay.account.installmentNgn).toBe(15_000);

    const afterBal = db.prepare(`SELECT balance FROM treasury_accounts WHERE id = ?`).get(ta.id)?.balance;
    expect(Math.round(Number(afterBal) || 0) - Math.round(Number(beforeBal) || 0)).toBe(60_000);
  });

  it('pauses payroll deductions and excludes from breakdown', () => {
    const created = migrateLegacyStaffLoan(db, actor, {
      userId: staffUserId,
      principalOriginalNgn: 60_000,
      installmentNgn: 15_000,
      termMonths: 4,
      title: 'Pause test loan',
    });
    expect(created.ok).toBe(true);

    const before = activeObligationBreakdownForPayroll(db, staffUserId);
    expect(before?.total).toBeGreaterThan(0);

    const paused = patchObligationDeductionPause(db, created.account.id, actor, {
      pause: true,
      reason: 'Hardship arrangement',
      pauseUntilIso: '2099-12-31',
    });
    expect(paused.ok).toBe(true);
    expect(paused.account.deductionsActive).toBe(false);

    const after = activeObligationBreakdownForPayroll(db, staffUserId);
    const stillListed = after?.items?.some((i) => i.obligationAccountId === created.account.id);
    expect(stillListed).toBeFalsy();

    const resumed = patchObligationDeductionPause(db, created.account.id, actor, { pause: false });
    expect(resumed.ok).toBe(true);
    expect(resumed.account.deductionsActive).toBe(true);
  });

  it('chairman waiver writes off remaining balance', () => {
    const created = migrateLegacyStaffLoan(db, actor, {
      userId: staffUserId,
      principalOriginalNgn: 40_000,
      installmentNgn: 10_000,
      termMonths: 4,
      title: 'Waiver test loan',
    });
    expect(created.ok).toBe(true);

    const waived = chairmanWaiveObligationBalance(db, created.account.id, { ...actor, roleKey: 'md', permissions: ['*'] }, {
      note: 'Board approved waiver UAT',
    });
    expect(waived.ok).toBe(true);
    expect(waived.account.principalOutstandingNgn).toBe(0);
    expect(waived.account.status).toBe('paid_off');

    const detail = getStaffObligationAccountDetail(db, created.account.id);
    expect(detail.transactions.some((t) => t.type === 'write_off')).toBe(true);
  });
});
