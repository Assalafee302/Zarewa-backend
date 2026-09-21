/**
 * Till/bank pay of an overpayment refund undoes Confirm-payment credit that consumed residual.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDatabase } from '../db.js';
import { applyRefundCreditToQuotation } from '../refundCreditApplyOps.js';
import { insertLedgerRows, payRefundEntry, syncQuotationPaidFromLedger } from '../writeOps.js';
import { REFUND_CREDIT_REVERSED_STATUS } from '../../shared/lib/refundCreditApply.js';
import { DEFAULT_BRANCH_ID } from '../branches.js';
import {
  quotationOverpayResidualExcludingRefund,
  releaseSourceQuoteOverpayCreditsForPayout,
} from './refundPayReleaseOverpayCredit.js';

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

describe.skipIf(!mysqlOk)('pay overpayment refund releases confirm-payment credit', () => {
  let db;
  let treasuryAccountId;

  beforeAll(() => {
    db = createDatabase(':memory:');
    const lines = JSON.stringify({
      products: [{ name: 'Roof', qty: 10, unitPrice: 10000 }],
      accessories: [],
      services: [],
    });
    db.exec(`
      INSERT INTO app_users (id, username, display_name, password_hash, role_key, created_at_iso)
      VALUES ('u-fin', 'fin1', 'Finance One', 'hash', 'finance', '2026-01-01T00:00:00.000Z');
      INSERT INTO customers (customer_id, name, branch_id)
      VALUES ('CUS-OP-REL', 'Overpay Release Customer', '${DEFAULT_BRANCH_ID}');
      INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso, branch_id)
      VALUES
        ('QT-OP-SRC', 'CUS-OP-REL', 'Overpay Release Customer', 100000, 147450, 'Paid', 'Finished', '${lines.replace(/'/g, "''")}', '2026-09-01', '${DEFAULT_BRANCH_ID}'),
        ('QT-OP-DST', 'CUS-OP-REL', 'Overpay Release Customer', 40000, 0, 'Unpaid', 'Draft', '${lines.replace(/'/g, "''")}', '2026-09-02', '${DEFAULT_BRANCH_ID}');
    `);
    const treasury = db
      .prepare(
        `INSERT INTO treasury_accounts (name, account_type, opening_balance_ngn, branch_id, is_active)
         VALUES ('Till Test', 'Cash', 5_000_000, ?, 1)`
      )
      .run(DEFAULT_BRANCH_ID);
    treasuryAccountId = Number(treasury.lastInsertRowid);
    insertLedgerRows(
      db,
      [
        {
          type: 'RECEIPT',
          customerID: 'CUS-OP-REL',
          customerName: 'Overpay Release Customer',
          amountNgn: 100_000,
          quotationRef: 'QT-OP-SRC',
          atISO: '2026-09-01T12:00:00.000Z',
        },
        {
          type: 'OVERPAY_ADVANCE',
          customerID: 'CUS-OP-REL',
          customerName: 'Overpay Release Customer',
          amountNgn: 47_450,
          quotationRef: 'QT-OP-SRC',
          atISO: '2026-09-01T12:00:00.000Z',
        },
      ],
      DEFAULT_BRANCH_ID
    );
    syncQuotationPaidFromLedger(db, 'QT-OP-SRC');
    syncQuotationPaidFromLedger(db, 'QT-OP-DST');
  }, 120_000);

  afterAll(() => {
    db?.close();
  });

  const actor = {
    id: 'u-fin',
    displayName: 'Finance One',
    roleKey: 'finance',
    permissions: ['finance.pay', 'finance.reverse', '*'],
  };

  it('releases leftover confirm credit then allows till payout', () => {
    const applied = applyRefundCreditToQuotation(db, {
      customerID: 'CUS-OP-REL',
      targetQuotationRef: 'QT-OP-DST',
      sourceIds: ['overpay:QT-OP-SRC'],
      actor,
      branchId: DEFAULT_BRANCH_ID,
      dateISO: '2026-09-03',
    });
    expect(applied.ok).toBe(true);
    expect(applied.appliedNgn).toBe(40_000);

    db.prepare(
      `INSERT INTO customer_refunds (
         refund_id, customer_id, customer_name, quotation_ref, reason_category, reason,
         amount_ngn, approved_amount_ngn, status, requested_by, requested_at_iso,
         reviewed_by, reviewed_at_iso, paid_amount_ngn, branch_id, calculation_lines_json
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      'RF-OP-PAY',
      'CUS-OP-REL',
      'Overpay Release Customer',
      'QT-OP-SRC',
      '["Overpayment"]',
      'Customer overpaid',
      47_450,
      47_450,
      'Approved',
      'Sales',
      '2026-09-04T10:00:00.000Z',
      'Manager',
      '2026-09-04T11:00:00.000Z',
      0,
      DEFAULT_BRANCH_ID,
      JSON.stringify([{ category: 'Overpayment', amountNgn: 47_450, label: 'Overpay' }])
    );

    const residualBefore = quotationOverpayResidualExcludingRefund(db, 'QT-OP-SRC', 'RF-OP-PAY');
    expect(residualBefore).toBeLessThan(47_450);

    const paid = payRefundEntry(db, 'RF-OP-PAY', {
      actor,
      paidBy: 'Finance One',
      paymentNote: 'Taj transfer already sent to customer',
      paidAtISO: '2026-09-21',
      paymentLines: [{ treasuryAccountId, amountNgn: 47_450, reference: 'MON-8117472559' }],
      workspaceBranchId: DEFAULT_BRANCH_ID,
      workspaceViewAll: true,
    });
    expect(paid.ok).toBe(true);
    expect(paid.fullyPaid).toBe(true);
    expect(paid.releasedOverpayCredits?.length).toBeGreaterThan(0);

    const apps = db
      .prepare(
        `SELECT status FROM refund_credit_applications WHERE source_quotation_ref = 'QT-OP-SRC'`
      )
      .all();
    expect(apps.every((a) => String(a.status) === REFUND_CREDIT_REVERSED_STATUS)).toBe(true);

    const rf = db.prepare(`SELECT status, paid_amount_ngn, payment_note FROM customer_refunds WHERE refund_id = 'RF-OP-PAY'`).get();
    expect(String(rf.status)).toBe('Paid');
    expect(Number(rf.paid_amount_ngn)).toBe(47_450);
    expect(String(rf.payment_note || '')).toMatch(/Undid|confirm-payment credit/i);

    const dst = db.prepare(`SELECT paid_ngn FROM quotations WHERE id = 'QT-OP-DST'`).get();
    expect(Number(dst.paid_ngn)).toBe(0);
  });

  it('release helper stops once residual covers need', () => {
    const r = releaseSourceQuoteOverpayCreditsForPayout(db, {
      sourceQuotationRef: 'QT-OP-SRC',
      excludeRefundId: 'RF-NONE',
      needResidualNgn: 1,
      actor,
      dateISO: '2026-09-21',
    });
    expect(r.ok).toBe(true);
    expect(r.residualNgn).toBeGreaterThanOrEqual(1);
  });
});
