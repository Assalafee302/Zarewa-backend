import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import { DEFAULT_BRANCH_ID } from './branches.js';
import { buildDebtorsRegister } from './accountingSubledgerOps.js';

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

describe.skipIf(!mysqlOk)('debtors pre-production deposits and refund commitments', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
  });

  afterEach(() => {
    db?.close();
  });

  it('lists cleared pre-production quote payments as customer deposits', () => {
    db.exec(`
      INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso, branch_id)
      VALUES ('QT-PRE-1', 'CUS-1', 'Test Customer', 500000, 500000, 'Paid', 'Approved', '{}', '2026-05-01', '${DEFAULT_BRANCH_ID}');
      INSERT INTO sales_receipts (id, customer_id, customer_name, quotation_ref, amount_ngn, status, date_iso, branch_id,
        finance_reconciliation_saved_at_iso, bank_received_amount_ngn)
      VALUES ('SR-PRE-1', 'CUS-1', 'Test Customer', 'QT-PRE-1', 500000, 'Posted', '2026-05-01', '${DEFAULT_BRANCH_ID}',
        '2026-05-01T10:00:00.000Z', 500000);
      INSERT INTO production_jobs (job_id, quotation_ref, status, planned_meters, actual_meters, branch_id, created_at_iso)
      VALUES ('JOB-PRE-1', 'QT-PRE-1', 'Planned', 100, 0, '${DEFAULT_BRANCH_ID}', '2026-05-01T10:00:00.000Z');
    `);

    const reg = buildDebtorsRegister(db, { branchId: DEFAULT_BRANCH_ID });
    const section = reg.sections.find((s) => s.id === 'pre_production_deposits');
    expect(section?.count).toBe(1);
    expect(section?.subtotalNgn).toBe(500_000);
    expect(section?.items[0].quotationRef).toBe('QT-PRE-1');
  });

  it('lists approved unpaid refunds on closed production as commitments', () => {
    db.exec(`
      INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso, branch_id)
      VALUES ('QT-REF-1', 'CUS-1', 'Test Customer', 500000, 500000, 'Paid', 'Finished', '{}', '2026-04-01', '${DEFAULT_BRANCH_ID}');
      INSERT INTO production_jobs (job_id, quotation_ref, status, planned_meters, actual_meters, branch_id, created_at_iso)
      VALUES ('JOB-REF-1', 'QT-REF-1', 'Cancelled', 100, 0, '${DEFAULT_BRANCH_ID}', '2026-04-02T10:00:00.000Z');
      INSERT INTO customer_refunds (
        refund_id, customer_id, customer_name, quotation_ref, product, reason_category, reason,
        amount_ngn, approved_amount_ngn, paid_amount_ngn, status, requested_by, requested_at_iso,
        approval_date, approved_by, branch_id
      ) VALUES (
        'RF-COMMIT-1', 'CUS-1', 'Test Customer', 'QT-REF-1', '—', '["Adjustment"]',
        'Cancel refund', 75000, 75000, 0, 'Approved', 'Sales', '2026-04-03', '2026-04-04', 'BM', '${DEFAULT_BRANCH_ID}'
      );
    `);

    const reg = buildDebtorsRegister(db, { branchId: DEFAULT_BRANCH_ID });
    const section = reg.sections.find((s) => s.id === 'customer_refund_commitments');
    expect(section?.count).toBe(1);
    expect(section?.subtotalNgn).toBe(75_000);
    expect(section?.items[0].id).toBe('RF-COMMIT-1');
    expect(section?.items[0].refundStatus).toBe('Approved');
  });

  it('excludes blocked quotations from pre-production deposits and refund commitments', () => {
    db.exec(`
      INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso, branch_id,
        refunds_blocked_at_iso, refunds_blocked_reason)
      VALUES ('QT-BLOCK-1', 'CUS-1', 'Test Customer', 500000, 500000, 'Paid', 'Approved', '{}', '2026-05-01', '${DEFAULT_BRANCH_ID}',
        '2026-06-01T10:00:00.000Z', 'Finance correction — do not refund');
      INSERT INTO sales_receipts (id, customer_id, customer_name, quotation_ref, amount_ngn, status, date_iso, branch_id,
        finance_reconciliation_saved_at_iso, bank_received_amount_ngn)
      VALUES ('SR-BLOCK-1', 'CUS-1', 'Test Customer', 'QT-BLOCK-1', 500000, 'Posted', '2026-05-01', '${DEFAULT_BRANCH_ID}',
        '2026-05-01T10:00:00.000Z', 500000);
      INSERT INTO production_jobs (job_id, quotation_ref, status, planned_meters, actual_meters, branch_id, created_at_iso)
      VALUES ('JOB-BLOCK-1', 'QT-BLOCK-1', 'Cancelled', 100, 0, '${DEFAULT_BRANCH_ID}', '2026-05-02T10:00:00.000Z');
      INSERT INTO customer_refunds (
        refund_id, customer_id, customer_name, quotation_ref, product, reason_category, reason,
        amount_ngn, approved_amount_ngn, paid_amount_ngn, status, requested_by, requested_at_iso,
        approval_date, approved_by, branch_id
      ) VALUES (
        'RF-BLOCK-1', 'CUS-1', 'Test Customer', 'QT-BLOCK-1', '—', '["Adjustment"]',
        'Should not show', 50000, 50000, 0, 'Approved', 'Sales', '2026-05-03', '2026-05-04', 'BM', '${DEFAULT_BRANCH_ID}'
      );
    `);

    const reg = buildDebtorsRegister(db, { branchId: DEFAULT_BRANCH_ID });
    const pre = reg.sections.find((s) => s.id === 'pre_production_deposits');
    const commits = reg.sections.find((s) => s.id === 'customer_refund_commitments');
    expect(pre?.items.some((i) => i.quotationRef === 'QT-BLOCK-1')).toBe(false);
    expect(commits?.items.some((i) => i.id === 'RF-BLOCK-1')).toBe(false);
  });
});
