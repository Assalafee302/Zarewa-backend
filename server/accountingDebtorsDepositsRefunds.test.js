import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import { DEFAULT_BRANCH_ID } from './branches.js';
import { buildDebtorsRegister } from './accountingSubledgerOps.js';
import { MIN_ACCOUNTING_REGISTER_LINE_NGN } from '../shared/lib/accountingRegisterConstants.js';

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

function insertTestCustomer(db, customerId = 'CUS-1') {
  db.prepare(`INSERT INTO customers (customer_id, name, branch_id) VALUES (?, 'Test Customer', ?)`).run(
    customerId,
    DEFAULT_BRANCH_ID
  );
}

describe.skipIf(!mysqlOk)('debtors deposits and refund payables register', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:', { seed: false });
  });

  afterEach(() => {
    db?.close();
  });

  it('lists on-line deposit when cutting list is registered and job is Planned', () => {
    insertTestCustomer(db);
    db.exec(`
      INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso, branch_id)
      VALUES ('QT-PRE-1', 'CUS-1', 'Test Customer', 500000, 500000, 'Paid', 'Approved', '{}', '2026-05-01', '${DEFAULT_BRANCH_ID}');
      INSERT INTO cutting_lists (id, customer_id, customer_name, quotation_ref, date_iso, branch_id, production_registered, status)
      VALUES ('CL-PRE-1', 'CUS-1', 'Test Customer', 'QT-PRE-1', '2026-05-01', '${DEFAULT_BRANCH_ID}', 1, 'Approved');
      INSERT INTO sales_receipts (id, customer_id, customer_name, quotation_ref, amount_ngn, status, date_iso, branch_id,
        finance_reconciliation_saved_at_iso, bank_received_amount_ngn)
      VALUES ('SR-PRE-1', 'CUS-1', 'Test Customer', 'QT-PRE-1', 500000, 'Posted', '2026-05-01', '${DEFAULT_BRANCH_ID}',
        '2026-05-01T10:00:00.000Z', 500000);
      INSERT INTO production_jobs (job_id, quotation_ref, status, planned_meters, actual_meters, branch_id, created_at_iso)
      VALUES ('JOB-PRE-1', 'QT-PRE-1', 'Planned', 100, 0, '${DEFAULT_BRANCH_ID}', '2026-05-01T10:00:00.000Z');
    `);

    const reg = buildDebtorsRegister(db, { branchId: DEFAULT_BRANCH_ID });
    const onLine = reg.sections.find((s) => s.id === 'deposit_on_production_line');
    const backlog = reg.sections.find((s) => s.id === 'deposit_paid_backlog');
    expect(onLine?.count).toBe(1);
    expect(onLine?.subtotalNgn).toBe(500_000);
    expect(onLine?.items[0].quotationRef).toBe('QT-PRE-1');
    expect(backlog?.count).toBe(0);
  });

  it('lists backlog deposit when paid but not on production line', () => {
    insertTestCustomer(db);
    db.exec(`
      INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso, branch_id)
      VALUES ('QT-BACK-1', 'CUS-1', 'Test Customer', 500000, 500000, 'Paid', 'Approved', '{}', '2026-05-01', '${DEFAULT_BRANCH_ID}');
      INSERT INTO sales_receipts (id, customer_id, customer_name, quotation_ref, amount_ngn, status, date_iso, branch_id,
        finance_reconciliation_saved_at_iso, bank_received_amount_ngn)
      VALUES ('SR-BACK-1', 'CUS-1', 'Test Customer', 'QT-BACK-1', 500000, 'Posted', '2026-05-01', '${DEFAULT_BRANCH_ID}',
        '2026-05-01T10:00:00.000Z', 500000);
    `);

    const reg = buildDebtorsRegister(db, { branchId: DEFAULT_BRANCH_ID });
    const backlog = reg.sections.find((s) => s.id === 'deposit_paid_backlog');
    expect(backlog?.count).toBe(1);
    expect(backlog?.items[0].quotationRef).toBe('QT-BACK-1');
  });

  it('excludes cancelled-not-produced paid quotes from deposit sections', () => {
    insertTestCustomer(db);
    db.exec(`
      INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso, branch_id)
      VALUES ('QT-CAN-1', 'CUS-1', 'Test Customer', 500000, 500000, 'Paid', 'Approved', '{}', '2026-05-01', '${DEFAULT_BRANCH_ID}');
      INSERT INTO sales_receipts (id, customer_id, customer_name, quotation_ref, amount_ngn, status, date_iso, branch_id,
        finance_reconciliation_saved_at_iso, bank_received_amount_ngn)
      VALUES ('SR-CAN-1', 'CUS-1', 'Test Customer', 'QT-CAN-1', 500000, 'Posted', '2026-05-01', '${DEFAULT_BRANCH_ID}',
        '2026-05-01T10:00:00.000Z', 500000);
      INSERT INTO production_jobs (job_id, quotation_ref, status, planned_meters, actual_meters, branch_id, created_at_iso)
      VALUES ('JOB-CAN-1', 'QT-CAN-1', 'Cancelled', 100, 0, '${DEFAULT_BRANCH_ID}', '2026-05-02T10:00:00.000Z');
    `);

    const reg = buildDebtorsRegister(db, { branchId: DEFAULT_BRANCH_ID });
    const onLine = reg.sections.find((s) => s.id === 'deposit_on_production_line');
    const backlog = reg.sections.find((s) => s.id === 'deposit_paid_backlog');
    expect(onLine?.count).toBe(0);
    expect(backlog?.count).toBe(0);
  });

  it('lists approved unpaid refunds as refund payables', () => {
    insertTestCustomer(db);
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
    const item = section?.items.find((i) => i.id === 'RF-COMMIT-1');
    expect(item).toBeTruthy();
    expect(item?.amountNgn).toBe(75_000);
    expect(item?.refundStatus).toBe('Approved');
  });

  it('includes approved refunds even when an open production job exists', () => {
    insertTestCustomer(db);
    db.exec(`
      INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso, branch_id)
      VALUES ('QT-OPEN-1', 'CUS-1', 'Test Customer', 500000, 500000, 'Paid', 'Finished', '{}', '2026-04-01', '${DEFAULT_BRANCH_ID}');
      INSERT INTO production_jobs (job_id, quotation_ref, status, planned_meters, actual_meters, branch_id, created_at_iso)
      VALUES
        ('JOB-CLOSED-1', 'QT-OPEN-1', 'Cancelled', 100, 0, '${DEFAULT_BRANCH_ID}', '2026-04-02T10:00:00.000Z'),
        ('JOB-OPEN-1', 'QT-OPEN-1', 'Planned', 100, 0, '${DEFAULT_BRANCH_ID}', '2026-04-03T10:00:00.000Z');
      INSERT INTO customer_refunds (
        refund_id, customer_id, customer_name, quotation_ref, product, reason_category, reason,
        amount_ngn, approved_amount_ngn, paid_amount_ngn, status, requested_by, requested_at_iso,
        approval_date, approved_by, branch_id
      ) VALUES (
        'RF-OPEN-1', 'CUS-1', 'Test Customer', 'QT-OPEN-1', '—', '["Adjustment"]',
        'Partial refund', 50000, 50000, 0, 'Approved', 'Sales', '2026-04-03', '2026-04-04', 'BM', '${DEFAULT_BRANCH_ID}'
      );
    `);

    const reg = buildDebtorsRegister(db, { branchId: DEFAULT_BRANCH_ID });
    const section = reg.sections.find((s) => s.id === 'customer_refund_commitments');
    expect(section?.items.some((i) => i.id === 'RF-OPEN-1')).toBe(true);
  });

  it('excludes paid refunds from refund payables', () => {
    insertTestCustomer(db);
    db.exec(`
      INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso, branch_id)
      VALUES ('QT-PAID-RF', 'CUS-1', 'Test Customer', 500000, 500000, 'Paid', 'Finished', '{}', '2026-04-01', '${DEFAULT_BRANCH_ID}');
      INSERT INTO customer_refunds (
        refund_id, customer_id, customer_name, quotation_ref, product, reason_category, reason,
        amount_ngn, approved_amount_ngn, paid_amount_ngn, status, requested_by, requested_at_iso,
        approval_date, approved_by, branch_id, paid_at_iso
      ) VALUES (
        'RF-PAID-1', 'CUS-1', 'Test Customer', 'QT-PAID-RF', '—', '["Overpayment"]',
        'Paid out', 50000, 50000, 50000, 'Paid', 'Sales', '2026-04-03', '2026-04-04', 'BM', '${DEFAULT_BRANCH_ID}', '2026-04-05'
      );
    `);

    const reg = buildDebtorsRegister(db, { branchId: DEFAULT_BRANCH_ID });
    const section = reg.sections.find((s) => s.id === 'customer_refund_commitments');
    expect(section?.items.some((i) => i.id === 'RF-PAID-1')).toBe(false);
  });

  it('excludes staff purchase credit quotations from deposit sections', () => {
    insertTestCustomer(db);
    db.exec(`
      INSERT INTO app_users (id, username, display_name, password_hash, role_key, created_at_iso)
      VALUES ('USR-SPC-1', 'staff.spc', 'Staff Buyer', 'hash', 'staff', '2026-01-01T00:00:00.000Z');
      INSERT INTO hr_staff_obligation_accounts (
        id, user_id, branch_id, kind, title, principal_original_ngn, principal_outstanding_ngn,
        status, created_at_iso, updated_at_iso, quotation_ref
      ) VALUES (
        'SPC-ACCT-1', 'USR-SPC-1', '${DEFAULT_BRANCH_ID}', 'purchase', 'Staff roof purchase',
        500000, 500000, 'active', '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z', 'QT-SPC-1'
      );
      INSERT INTO quotations (
        id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso, branch_id,
        is_staff_purchase, staff_purchase_credit_id
      ) VALUES (
        'QT-SPC-1', 'CUS-1', 'Test Customer', 500000, 500000, 'Paid', 'Approved', '{}', '2026-05-01', '${DEFAULT_BRANCH_ID}',
        1, 'SPC-ACCT-1'
      );
      INSERT INTO ledger_entries (id, type, customer_id, quotation_ref, amount_ngn, at_iso, branch_id)
      VALUES ('LE-SPC', 'STAFF_PURCHASE_CREDIT', 'CUS-1', 'QT-SPC-1', 500000, '2026-05-01T12:00:00.000Z', '${DEFAULT_BRANCH_ID}');
      INSERT INTO production_jobs (job_id, quotation_ref, status, planned_meters, actual_meters, branch_id, created_at_iso)
      VALUES ('JOB-SPC-1', 'QT-SPC-1', 'Planned', 100, 0, '${DEFAULT_BRANCH_ID}', '2026-05-01T10:00:00.000Z');
    `);

    const reg = buildDebtorsRegister(db, { branchId: DEFAULT_BRANCH_ID });
    const onLine = reg.sections.find((s) => s.id === 'deposit_on_production_line');
    const backlog = reg.sections.find((s) => s.id === 'deposit_paid_backlog');
    expect(onLine?.items.some((i) => i.quotationRef === 'QT-SPC-1')).toBe(false);
    expect(backlog?.items.some((i) => i.quotationRef === 'QT-SPC-1')).toBe(false);
  });

  it('excludes blocked quotations from deposits and refund payables', () => {
    insertTestCustomer(db);
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
    const onLine = reg.sections.find((s) => s.id === 'deposit_on_production_line');
    const backlog = reg.sections.find((s) => s.id === 'deposit_paid_backlog');
    const commits = reg.sections.find((s) => s.id === 'customer_refund_commitments');
    expect(onLine?.items.some((i) => i.quotationRef === 'QT-BLOCK-1')).toBe(false);
    expect(backlog?.items.some((i) => i.quotationRef === 'QT-BLOCK-1')).toBe(false);
    expect(commits?.items.some((i) => i.id === 'RF-BLOCK-1')).toBe(false);
  });

  it(`omits register lines below ₦${MIN_ACCOUNTING_REGISTER_LINE_NGN}`, () => {
    insertTestCustomer(db);
    db.exec(`
      INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso, branch_id)
      VALUES ('QT-SMALL', 'CUS-1', 'Test Customer', 1000, 1000, 'Paid', 'Approved', '{}', '2026-05-01', '${DEFAULT_BRANCH_ID}');
      INSERT INTO sales_receipts (id, customer_id, customer_name, quotation_ref, amount_ngn, status, date_iso, branch_id,
        finance_reconciliation_saved_at_iso, bank_received_amount_ngn)
      VALUES ('SR-SMALL', 'CUS-1', 'Test Customer', 'QT-SMALL', 1000, 'Posted', '2026-05-01', '${DEFAULT_BRANCH_ID}',
        '2026-05-01T10:00:00.000Z', 1000);
    `);

    const reg = buildDebtorsRegister(db, { branchId: DEFAULT_BRANCH_ID });
    expect(reg.minRegisterLineNgn).toBe(1500);
    const backlog = reg.sections.find((s) => s.id === 'deposit_paid_backlog');
    expect(backlog?.count).toBe(0);
  });
});
