import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import { DEFAULT_BRANCH_ID } from './branches.js';
import { buildExpenseCategoryExceptionReport } from './expenseCategoryReportOps.js';

function mysqlAvailable() {
  try {
    const probe = createDatabase(':memory:', { seed: false });
    probe.close();
    return true;
  } catch {
    return false;
  }
}

const mysqlOk = mysqlAvailable();

describe.skipIf(!mysqlOk)('buildExpenseCategoryExceptionReport', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
    db.prepare(
      `INSERT INTO expenses (expense_id, expense_type, amount_ngn, date, category, payment_method, reference, branch_id)
       VALUES
         ('EXP-EX-PEND', 'Pending others', 100000, '2026-04-10', 'Others', 'Pending', 'P1', ?),
         ('EXP-EX-APPR', 'Approved others', 40000, '2026-04-12', 'Others', 'Pending', 'P2', ?),
         ('EXP-EX-PAID', 'Paid others', 25000, '2026-04-15', 'Others', 'Cash', 'P3', ?),
         ('EXP-EX-OLD', 'Old others', 99000, '2026-01-01', 'Others', 'Pending', 'P4', ?)`
    ).run(DEFAULT_BRANCH_ID, DEFAULT_BRANCH_ID, DEFAULT_BRANCH_ID, DEFAULT_BRANCH_ID);

    db.prepare(
      `INSERT INTO payment_requests (
         request_id, expense_id, amount_requested_ngn, request_date, approval_status, description, paid_amount_ngn
       ) VALUES
         ('PREQ-EX-PEND', 'EXP-EX-PEND', 100000, '2026-04-10', 'Pending', 'Pending others', 0),
         ('PREQ-EX-APPR', 'EXP-EX-APPR', 40000, '2026-04-12', 'Approved', 'Approved others', 0),
         ('PREQ-EX-PAID', 'EXP-EX-PAID', 25000, '2026-04-15', 'Approved', 'Paid others', 25000),
         ('PREQ-EX-OLD', 'EXP-EX-OLD', 99000, '2026-01-01', 'Approved', 'Old others', 99000)`
    ).run();
  });

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('date-filters in SQL and excludes pending from the default NGN total', () => {
    const report = buildExpenseCategoryExceptionReport(db, {
      startISO: '2026-04-01',
      endISO: '2026-04-30',
      branchScope: DEFAULT_BRANCH_ID,
    });
    expect(report.ok).toBe(true);
    expect(report.rows.some((r) => r.requestID === 'PREQ-EX-OLD')).toBe(false);
    expect(report.rows.some((r) => r.requestID === 'PREQ-EX-PEND')).toBe(true);
    expect(report.summary.pendingNgn).toBe(100_000);
    expect(report.summary.approvedUnpaidNgn).toBe(40_000);
    expect(report.summary.paidNgn).toBe(25_000);
    expect(report.summary.totalNgn).toBe(65_000);
    const pending = report.rows.find((r) => r.requestID === 'PREQ-EX-PEND');
    expect(pending.cashStage).toBe('pending');
  });
});
