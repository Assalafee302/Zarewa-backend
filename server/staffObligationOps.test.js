import { beforeAll, describe, expect, it } from 'vitest';
import { acquireIntegrationHarness, isMysqlAvailableForTests, resolveTestActor } from './testIntegrationHarness.js';
import {
  activeObligationBreakdownForPayroll,
  getStaffObligationAccountDetail,
  migrateLegacyStaffLoan,
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
});
