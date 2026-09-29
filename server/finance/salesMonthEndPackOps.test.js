import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from '../db.js';
import { DEFAULT_BRANCH_ID } from '../branches.js';
import { buildSalesMonthEndPackFromDb } from './salesMonthEndPackOps.js';

function mysqlAvailable() {
  try {
    const db = createDatabase(':memory:', { seed: false });
    db.close();
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!mysqlAvailable())('sales month-end pack loader', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:', { seed: false });
    db.prepare(
      `INSERT INTO customers (customer_id, name, branch_id) VALUES ('CUS-P', 'Pack Customer', ?)`
    ).run(DEFAULT_BRANCH_ID);
    db.prepare(
      `INSERT INTO treasury_accounts (name, bank_name, balance, type, acc_no, branch_id, opening_balance_ngn)
       VALUES ('Pack Bank', 'GTBank', 0, 'Bank', 'PACK-1', ?, 0)`
    ).run(DEFAULT_BRANCH_ID);
    const treasuryId = Number(db.prepare(`SELECT id FROM treasury_accounts WHERE acc_no = 'PACK-1'`).get()?.id);
    db.prepare(
      `INSERT INTO quotations (id, customer_id, customer_name, date_iso, total_ngn, paid_ngn, status, branch_id)
       VALUES ('QT-P', 'CUS-P', 'Pack Customer', '2026-09-02', 100000, 100000, 'Pending', ?)`
    ).run(DEFAULT_BRANCH_ID);
    db.prepare(
      `INSERT INTO sales_receipts (id, customer_id, customer_name, quotation_ref, date_iso, amount_ngn, status, branch_id)
       VALUES ('LE-P', 'CUS-P', 'Pack Customer', 'QT-P', '2026-09-02', 100000, 'Cleared', ?)`
    ).run(DEFAULT_BRANCH_ID);
    db.prepare(
      `INSERT INTO treasury_movements (
         id, posted_at_iso, type, treasury_account_id, amount_ngn, reference,
         counterparty_name, source_kind, source_id, branch_id
       ) VALUES ('TM-IN', '2026-09-04T12:00:00.000Z', 'RECEIPT_IN', ?, 100000, 'R-1',
         'Pack Customer', 'LEDGER_RECEIPT', 'LE-P', ?)`
    ).run(treasuryId, DEFAULT_BRANCH_ID);
    db.prepare(
      `INSERT INTO treasury_movements (
         id, posted_at_iso, type, treasury_account_id, amount_ngn, reference,
         counterparty_name, source_kind, source_id, branch_id
       ) VALUES ('TM-OUT', '2026-09-06T12:00:00.000Z', 'REFUND_PAYOUT', ?, -25000, 'RF',
         'Pack Customer', 'REFUND', 'RF-P', ?)`
    ).run(treasuryId, DEFAULT_BRANCH_ID);
    db.prepare(
      `INSERT INTO customer_refunds (
         refund_id, customer_id, customer_name, quotation_ref, reason_category, amount_ngn,
         status, approved_amount_ngn, paid_amount_ngn, credit_applied_ngn, branch_id
       ) VALUES ('RF-P', 'CUS-P', 'Pack Customer', 'QT-P', '["Overpayment"]', 25000,
         'Paid', 25000, 25000, 0, ?)`
    ).run(DEFAULT_BRANCH_ID);
    db.prepare(
      `INSERT INTO production_jobs (
         job_id, quotation_ref, customer_name, status, created_at_iso, actual_meters, completed_at_iso, branch_id
       ) VALUES ('JOB-P', 'QT-P', 'Pack Customer', 'Completed', '2026-09-03T12:00:00.000Z', 8, '2026-09-05T12:00:00.000Z', ?)`
    ).run(DEFAULT_BRANCH_ID);
    db.prepare(
      `INSERT INTO treasury_movements (
         id, posted_at_iso, type, treasury_account_id, amount_ngn, source_kind, source_id, branch_id
       ) VALUES ('TM-BAD', '262026-09-T12:00:00.000Z', 'PAYMENT_REQUEST_OUT', ?, -36000, 'PAYMENT_REQUEST', 'PREQ-X', ?)`
    ).run(treasuryId, DEFAULT_BRANCH_ID);
  });

  afterEach(() => {
    db?.close();
  });

  it('reads the month from treasury and does not treat a broken date as September cash', () => {
    const pack = buildSalesMonthEndPackFromDb(db, { month: '2026-09', branchScope: DEFAULT_BRANCH_ID });
    expect(pack.ok).toBe(true);
    expect(pack.cover.bankInNgn).toBe(100_000);
    expect(pack.cover.bankOutNgn).toBe(25_000);
    expect(pack.cover.cashRefundsNgn).toBe(25_000);
    expect(pack.cover.receiptsDatedInMonthNgn).toBe(100_000);
    expect(pack.cover.revenueNgn).toBe(100_000);
    expect(pack.cover.netSalesNgn).toBe(100_000);
    expect(pack.exceptions.some((e) => e.code === 'malformed_treasury_date' && e.recordId === 'TM-BAD')).toBe(true);
    expect(pack.bankLines.some((r) => r.movementId === 'TM-BAD')).toBe(false);
  });
});
