import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDatabase } from '../db.js';
import { insertLedgerRows } from '../writeOps.js';
import { DEFAULT_BRANCH_ID } from '../branches.js';
import { healRefundCreditAppliedFromApplicationsTx } from './refundCreditHeal.js';
import { refundCashOutstandingNgn } from './refundPayoutStatus.js';
import { REFUND_CREDIT_CONFIRMATION_STATUS } from '../../shared/lib/refundCreditApply.js';

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

describe.skipIf(!mysqlOk)('healRefundCreditAppliedFromApplicationsTx (RF-KD-26-9578)', () => {
  let db;

  beforeAll(() => {
    db = createDatabase(':memory:');
  }, 120_000);

  afterAll(() => {
    db?.close();
  });

  it('stamps unlinked overpay applications that spent reserved refund cash onto the refund', () => {
    const lines = JSON.stringify({
      products: [{ name: 'Roof', qty: 1, unitPrice: 25_931_760 }],
      accessories: [],
      services: [],
    });
    db.exec(`
      INSERT INTO customers (customer_id, name, branch_id)
      VALUES ('CUS-KD-26-0510', 'Qs Isa', '${DEFAULT_BRANCH_ID}');
      INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso, branch_id)
      VALUES
        ('QT-KD-26-1394', 'CUS-KD-26-0510', 'Qs Isa', 25931760, 36946320, 'Paid', 'Finished', '${lines.replace(/'/g, "''")}', '2026-09-01', '${DEFAULT_BRANCH_ID}'),
        ('QT-KD-26-OTHER', 'CUS-KD-26-0510', 'Qs Isa', 3300060, 0, 'Unpaid', 'Draft', '${lines.replace(/'/g, "''")}', '2026-09-05', '${DEFAULT_BRANCH_ID}');
      INSERT INTO customer_refunds (
        refund_id, customer_id, customer_name, quotation_ref, reason_category, reason,
        amount_ngn, approved_amount_ngn, status, requested_by, requested_at_iso, paid_amount_ngn,
        paid_at_iso, paid_by, branch_id, credit_applied_ngn, calculation_lines_json, payee_name
      ) VALUES (
        'RF-KD-26-9578', 'CUS-KD-26-0510', 'Qs Isa', 'QT-KD-26-1394', '["Overpayment"]', 'Overpayment',
        7425560, 7425560, 'Approved', 'Sales One', '2026-09-02T10:00:00.000Z', 4125500,
        '2026-09-05', 'Cash Office', '${DEFAULT_BRANCH_ID}', 0,
        '${JSON.stringify([{ category: 'Overpayment', amountNgn: 7425560 }]).replace(/'/g, "''")}',
        'Abdulrahman sali'
      );
    `);
    insertLedgerRows(
      db,
      [
        {
          type: 'RECEIPT',
          customerID: 'CUS-KD-26-0510',
          customerName: 'Qs Isa',
          amountNgn: 36_946_320,
          quotationRef: 'QT-KD-26-1394',
          atISO: '2026-09-01T12:00:00.000Z',
        },
      ],
      DEFAULT_BRANCH_ID
    );
    db.exec(`
      INSERT INTO treasury_movements (
        id, treasury_account_id, direction, amount_ngn, posted_at_iso, source_kind, source_id, branch_id, note
      ) VALUES
        ('TM-9578-A', 1, 'out', 3900000, '2026-09-05T12:00:00.000Z', 'REFUND_PAYOUT', 'RF-KD-26-9578', '${DEFAULT_BRANCH_ID}', 'Zarewa Aluminum'),
        ('TM-9578-B', 1, 'out', 225500, '2026-09-05T12:00:00.000Z', 'REFUND_PAYOUT', 'RF-KD-26-9578', '${DEFAULT_BRANCH_ID}', 'Cash Office');
      INSERT INTO refund_credit_applications (
        application_id, customer_id, target_quotation_ref, source_quotation_ref, refund_id,
        kind, amount_ngn, status, ledger_bank_reference, created_at_iso, created_by_name, branch_id
      ) VALUES
        ('RCA-LEFTOVER-1', 'CUS-KD-26-0510', 'QT-KD-26-OTHER', 'QT-KD-26-1394', NULL,
         'overpay', 1949560, '${REFUND_CREDIT_CONFIRMATION_STATUS}', 'RCA-1', '2026-09-05T13:00:00.000Z', 'Cashier', '${DEFAULT_BRANCH_ID}'),
        ('RCA-LEFTOVER-2', 'CUS-KD-26-0510', 'QT-KD-26-OTHER', 'QT-KD-26-1394', NULL,
         'overpay', 1639440, '${REFUND_CREDIT_CONFIRMATION_STATUS}', 'RCA-2', '2026-09-05T13:01:00.000Z', 'Cashier', '${DEFAULT_BRANCH_ID}'),
        ('RCA-RESERVED', 'CUS-KD-26-0510', 'QT-KD-26-OTHER', 'QT-KD-26-1394', NULL,
         'overpay', 3300060, '${REFUND_CREDIT_CONFIRMATION_STATUS}', 'RCA-3', '2026-09-05T13:02:00.000Z', 'Cashier', '${DEFAULT_BRANCH_ID}');
    `);

    const before = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = 'RF-KD-26-9578'`).get();
    expect(refundCashOutstandingNgn(db, before)).toBe(3_300_060);

    const healed = healRefundCreditAppliedFromApplicationsTx(db, 'RF-KD-26-9578');
    expect(healed.ok).toBe(true);
    expect(healed.changed).toBe(true);
    expect(healed.creditAppliedNgn).toBe(3_300_060);

    const after = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = 'RF-KD-26-9578'`).get();
    expect(Number(after.credit_applied_ngn)).toBe(3_300_060);
    expect(refundCashOutstandingNgn(db, after)).toBe(0);
    expect(after.status).toBe('Paid');
  });
});
