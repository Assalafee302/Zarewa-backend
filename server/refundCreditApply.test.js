import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDatabase } from './db.js';
import {
  applyRefundCreditToQuotation,
  listEligibleRefundCredits,
  listRefundCreditApplications,
} from './refundCreditApplyOps.js';
import {
  insertLedgerRows,
  overpayCreditRemainingOnQuotationDb,
  overpayCreditNgnForCustomerDb,
  syncQuotationPaidFromLedger,
} from './writeOps.js';
import { REFUND_CREDIT_CONFIRMATION_STATUS } from '../shared/lib/refundCreditApply.js';
import { DEFAULT_BRANCH_ID } from './branches.js';

describe('apply refund credit to new quotation (integration)', () => {
  let db;

  beforeAll(() => {
    db = createDatabase(':memory:');
    const lines = JSON.stringify({
      products: [{ name: 'Roof', qty: 10, unitPrice: 10000 }],
      accessories: [],
      services: [],
    });
    db.exec(`
      INSERT INTO app_users (id, username, display_name, password_hash, role_key, created_at_iso)
      VALUES ('u-sales', 'sales1', 'Sales One', 'hash', 'sales_staff', '2026-01-01T00:00:00.000Z');
      INSERT INTO customers (customer_id, name, branch_id)
      VALUES ('CUS-RC', 'Credit Customer', '${DEFAULT_BRANCH_ID}');
      INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso, branch_id)
      VALUES
        ('QT-OLD', 'CUS-RC', 'Credit Customer', 100000, 150000, 'Paid', 'Finished', '${lines.replace(/'/g, "''")}', '2026-04-01', '${DEFAULT_BRANCH_ID}'),
        ('QT-NEW', 'CUS-RC', 'Credit Customer', 80000, 0, 'Unpaid', 'Draft', '${lines.replace(/'/g, "''")}', '2026-05-01', '${DEFAULT_BRANCH_ID}');
    `);
    insertLedgerRows(
      db,
      [
        {
          type: 'RECEIPT',
          customerID: 'CUS-RC',
          customerName: 'Credit Customer',
          amountNgn: 100_000,
          quotationRef: 'QT-OLD',
          atISO: '2026-04-02T12:00:00.000Z',
          note: 'Base receipt',
        },
        {
          type: 'OVERPAY_ADVANCE',
          customerID: 'CUS-RC',
          customerName: 'Credit Customer',
          amountNgn: 50_000,
          quotationRef: 'QT-OLD',
          atISO: '2026-04-02T12:00:00.000Z',
          note: 'Overpay',
        },
      ],
      DEFAULT_BRANCH_ID
    );
    // paid_ngn on QT-OLD already seeded; sync NEW from empty
    syncQuotationPaidFromLedger(db, 'QT-NEW');
  }, 120_000);

  afterAll(() => {
    db?.close();
  });

  const actor = { id: 'u-sales', displayName: 'Sales One', roleKey: 'sales_staff' };

  it('recommends overpay credit without a refund request', () => {
    const listed = listEligibleRefundCredits(db, 'CUS-RC', 'QT-NEW');
    expect(listed.ok).toBe(true);
    expect(listed.targetDueNgn).toBe(80_000);
    expect(listed.totalAvailableNgn).toBe(50_000);
    expect(listed.recommendedApplyNgn).toBe(50_000);
    expect(listed.sources[0].kind).toBe('overpay');
    expect(listed.sources[0].requiresApproval).toBe(false);
  });

  it('applies only what the new quote needs and leaves leftover overpay on old quote', () => {
    // Make overpay larger than new due so leftover remains.
    insertLedgerRows(
      db,
      [
        {
          type: 'OVERPAY_ADVANCE',
          customerID: 'CUS-RC',
          customerName: 'Credit Customer',
          amountNgn: 70_000,
          quotationRef: 'QT-OLD',
          atISO: '2026-04-03T12:00:00.000Z',
          note: 'More overpay',
        },
      ],
      DEFAULT_BRANCH_ID
    );
    // remaining overpay now 120k; due on new is 80k
    const applied = applyRefundCreditToQuotation(db, {
      customerID: 'CUS-RC',
      targetQuotationRef: 'QT-NEW',
      actor,
      branchId: DEFAULT_BRANCH_ID,
      dateISO: '2026-05-02',
    });
    expect(applied.ok).toBe(true);
    expect(applied.appliedNgn).toBe(80_000);
    expect(applied.status).toBe(REFUND_CREDIT_CONFIRMATION_STATUS);
    expect(applied.remainderDueNgn).toBe(0);
    expect(applied.targetPaymentStatus).toBe('Paid');

    const leftover = overpayCreditRemainingOnQuotationDb(db, 'CUS-RC', 'QT-OLD');
    expect(leftover).toBe(40_000);

    const listedApps = listRefundCreditApplications(db, 'CUS-RC', 'ALL', {
      targetQuotationRef: 'QT-NEW',
    });
    expect(listedApps.length).toBeGreaterThan(0);
    expect(listedApps.every((a) => a.targetQuotationRef === 'QT-NEW')).toBe(true);
    expect(listedApps.reduce((s, a) => s + a.amountNgn, 0)).toBe(80_000);

    // No sales_receipt for the credit — not for bank clearance
    const rcpt = db
      .prepare(`SELECT COUNT(*) AS c FROM sales_receipts WHERE quotation_ref = 'QT-NEW'`)
      .get();
    expect(Number(rcpt?.c) || 0).toBe(0);

    const appliedLedger = db
      .prepare(
        `SELECT COALESCE(SUM(amount_ngn),0) AS s FROM ledger_entries
         WHERE type = 'OVERPAY_APPLIED' AND quotation_ref = 'QT-NEW'`
      )
      .get();
    expect(Number(appliedLedger?.s)).toBe(80_000);

    const apps = db
      .prepare(`SELECT status, amount_ngn FROM refund_credit_applications WHERE target_quotation_ref = 'QT-NEW'`)
      .all();
    expect(apps.length).toBeGreaterThan(0);
    expect(apps.every((a) => a.status === REFUND_CREDIT_CONFIRMATION_STATUS)).toBe(true);
  });

  it('consumes Pending overpayment refund without manager approval and leaves unpaid refund balance', () => {
    // Fresh quotes for refund path
    const lines = JSON.stringify({
      products: [{ name: 'Roof', qty: 5, unitPrice: 10000 }],
      accessories: [],
      services: [],
    });
    db.exec(`
      INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso, branch_id)
      VALUES
        ('QT-RF-SRC', 'CUS-RC', 'Credit Customer', 50000, 90000, 'Paid', 'Finished', '${lines.replace(/'/g, "''")}', '2026-06-01', '${DEFAULT_BRANCH_ID}'),
        ('QT-RF-DST', 'CUS-RC', 'Credit Customer', 30000, 0, 'Unpaid', 'Draft', '${lines.replace(/'/g, "''")}', '2026-06-02', '${DEFAULT_BRANCH_ID}');
    `);
    insertLedgerRows(
      db,
      [
        {
          type: 'RECEIPT',
          customerID: 'CUS-RC',
          customerName: 'Credit Customer',
          amountNgn: 50_000,
          quotationRef: 'QT-RF-SRC',
          atISO: '2026-06-01T12:00:00.000Z',
        },
        {
          type: 'OVERPAY_ADVANCE',
          customerID: 'CUS-RC',
          customerName: 'Credit Customer',
          amountNgn: 40_000,
          quotationRef: 'QT-RF-SRC',
          atISO: '2026-06-01T12:00:00.000Z',
        },
      ],
      DEFAULT_BRANCH_ID
    );
    db.prepare(
      `INSERT INTO customer_refunds (
         refund_id, customer_id, customer_name, quotation_ref, reason_category, reason,
         amount_ngn, status, requested_by, requested_at_iso, paid_amount_ngn, branch_id,
         calculation_lines_json
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      'RF-OVER-1',
      'CUS-RC',
      'Credit Customer',
      'QT-RF-SRC',
      '["Overpayment"]',
      'Customer overpaid',
      40_000,
      'Pending',
      'Sales One',
      '2026-06-01T13:00:00.000Z',
      0,
      DEFAULT_BRANCH_ID,
      JSON.stringify([{ category: 'Overpayment', amountNgn: 40_000, label: 'Overpay' }])
    );

    const listed = listEligibleRefundCredits(db, 'CUS-RC', 'QT-RF-DST');
    expect(listed.sources.some((s) => s.refundId === 'RF-OVER-1')).toBe(true);
    expect(listed.sources.find((s) => s.refundId === 'RF-OVER-1')?.requiresApproval).toBe(false);

    const applied = applyRefundCreditToQuotation(db, {
      customerID: 'CUS-RC',
      targetQuotationRef: 'QT-RF-DST',
      sourceIds: ['refund:RF-OVER-1'],
      actor,
      branchId: DEFAULT_BRANCH_ID,
      dateISO: '2026-06-03',
    });
    expect(applied.ok).toBe(true);
    expect(applied.appliedNgn).toBe(30_000);

    const rf = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = 'RF-OVER-1'`).get();
    expect(rf.status).toBe('Approved'); // partial — still open for cash refund of leftover
    expect(Number(rf.paid_amount_ngn)).toBe(30_000);
    expect(Number(rf.credit_applied_ngn)).toBe(30_000);
    expect(rf.credit_confirmation_status).toBe(REFUND_CREDIT_CONFIRMATION_STATUS);
    expect(rf.credit_applied_to_quotation_ref).toBe('QT-RF-DST');
    expect(Number(rf.approved_amount_ngn) - Number(rf.paid_amount_ngn)).toBe(10_000);

    const leftoverOverpay = overpayCreditRemainingOnQuotationDb(db, 'CUS-RC', 'QT-RF-SRC');
    expect(leftoverOverpay).toBe(10_000);
  });

  it('rejects Pending non-overpayment refunds until approved', () => {
    const lines = JSON.stringify({
      products: [{ name: 'Roof', qty: 2, unitPrice: 10000 }],
      accessories: [],
      services: [],
    });
    db.exec(`
      INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso, branch_id)
      VALUES
        ('QT-NP-SRC', 'CUS-RC', 'Credit Customer', 20000, 20000, 'Paid', 'Finished', '${lines.replace(/'/g, "''")}', '2026-07-01', '${DEFAULT_BRANCH_ID}'),
        ('QT-NP-DST', 'CUS-RC', 'Credit Customer', 15000, 0, 'Unpaid', 'Draft', '${lines.replace(/'/g, "''")}', '2026-07-02', '${DEFAULT_BRANCH_ID}');
      INSERT INTO customer_refunds (
         refund_id, customer_id, customer_name, quotation_ref, reason_category, reason,
         amount_ngn, status, requested_by, requested_at_iso, paid_amount_ngn, branch_id
       ) VALUES (
         'RF-METRE-1', 'CUS-RC', 'Credit Customer', 'QT-NP-SRC', '["Unproduced meterage"]', 'Short',
         15000, 'Pending', 'Sales One', '2026-07-01T13:00:00.000Z', 0, '${DEFAULT_BRANCH_ID}'
       );
    `);
    const listed = listEligibleRefundCredits(db, 'CUS-RC', 'QT-NP-DST');
    expect(listed.sources.some((s) => s.refundId === 'RF-METRE-1')).toBe(false);
    expect(listed.unavailableSources.some((s) => s.refundId === 'RF-METRE-1')).toBe(true);
    expect(listed.unavailableSources.find((s) => s.refundId === 'RF-METRE-1')?.reason).toMatch(
      /approval/i
    );

    db.prepare(
      `UPDATE customer_refunds SET status = 'Approved', approved_amount_ngn = 15000 WHERE refund_id = 'RF-METRE-1'`
    ).run();
    const listed2 = listEligibleRefundCredits(db, 'CUS-RC', 'QT-NP-DST');
    expect(listed2.sources.some((s) => s.refundId === 'RF-METRE-1')).toBe(true);

    const applied = applyRefundCreditToQuotation(db, {
      customerID: 'CUS-RC',
      targetQuotationRef: 'QT-NP-DST',
      sourceIds: ['refund:RF-METRE-1'],
      actor,
      branchId: DEFAULT_BRANCH_ID,
      dateISO: '2026-07-03',
    });
    expect(applied.ok).toBe(true);
    expect(applied.appliedNgn).toBe(15_000);
    const rf = db.prepare(`SELECT status, paid_amount_ngn, credit_confirmation_status FROM customer_refunds WHERE refund_id = 'RF-METRE-1'`).get();
    expect(rf.status).toBe('Paid');
    expect(Number(rf.paid_amount_ngn)).toBe(15_000);
    expect(rf.credit_confirmation_status).toBe(REFUND_CREDIT_CONFIRMATION_STATUS);
    // Fully settled via credit — not awaiting finance payout clearance
    expect(overpayCreditNgnForCustomerDb(db, 'CUS-RC', DEFAULT_BRANCH_ID)).toBeGreaterThanOrEqual(0);

    const again = applyRefundCreditToQuotation(db, {
      customerID: 'CUS-RC',
      targetQuotationRef: 'QT-NP-DST',
      sourceIds: ['refund:RF-METRE-1'],
      actor,
      branchId: DEFAULT_BRANCH_ID,
      dateISO: '2026-07-04',
    });
    expect(again.ok).toBe(false);
  });

  it('lists a same-quote pending overpay refund so Add payment can show it', () => {
    const lines = JSON.stringify({
      products: [{ name: 'Roof', qty: 5, unitPrice: 10000 }],
      accessories: [],
      services: [],
    });
    db.exec(`
      INSERT INTO customers (customer_id, name, branch_id)
      VALUES ('CUS-SAME', 'Same Quote Customer', '${DEFAULT_BRANCH_ID}');
      INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso, branch_id)
      VALUES
        ('QT-SAME-OP', 'CUS-SAME', 'Same Quote Customer', 50000, 80000, 'Paid', 'Finished', '${lines.replace(/'/g, "''")}', '2026-08-01', '${DEFAULT_BRANCH_ID}'),
        ('QT-SAME-DUE', 'CUS-SAME', 'Same Quote Customer', 20000, 0, 'Unpaid', 'Draft', '${lines.replace(/'/g, "''")}', '2026-08-02', '${DEFAULT_BRANCH_ID}');
    `);
    insertLedgerRows(
      db,
      [
        {
          type: 'RECEIPT',
          customerID: 'CUS-SAME',
          customerName: 'Same Quote Customer',
          amountNgn: 50_000,
          quotationRef: 'QT-SAME-OP',
          atISO: '2026-08-01T12:00:00.000Z',
        },
        {
          type: 'OVERPAY_ADVANCE',
          customerID: 'CUS-SAME',
          customerName: 'Same Quote Customer',
          amountNgn: 30_000,
          quotationRef: 'QT-SAME-OP',
          atISO: '2026-08-01T12:00:00.000Z',
        },
      ],
      DEFAULT_BRANCH_ID
    );
    db.exec(`
      INSERT INTO customer_refunds (
         refund_id, customer_id, customer_name, quotation_ref, reason_category, reason,
         amount_ngn, status, requested_by, requested_at_iso, paid_amount_ngn, branch_id,
         calculation_lines_json
       ) VALUES (
         'RF-SAME-1', 'CUS-SAME', 'Same Quote Customer', 'QT-SAME-OP', '["Overpayment"]', 'Overpaid',
         30000, 'Pending', 'Sales One', '2026-08-01T13:00:00.000Z', 0, '${DEFAULT_BRANCH_ID}',
         '${JSON.stringify([{ category: 'Overpayment', amountNgn: 30000, label: 'Overpay' }]).replace(/'/g, "''")}'
       );
    `);

    const listedOnDue = listEligibleRefundCredits(db, 'CUS-SAME', 'QT-SAME-DUE');
    expect(listedOnDue.sources.some((s) => s.refundId === 'RF-SAME-1')).toBe(true);
    expect(listedOnDue.recommendedApplyNgn).toBe(20_000);

    const listedOnSame = listEligibleRefundCredits(db, 'CUS-SAME', 'QT-SAME-OP');
    expect(listedOnSame.sources.some((s) => s.refundId === 'RF-SAME-1')).toBe(true);
    expect(listedOnSame.sources.find((s) => s.refundId === 'RF-SAME-1')?.sameQuotation).toBe(true);
    expect(listedOnSame.recommendedApplyNgn).toBe(0);
    expect(listedOnSame.totalAvailableNgn).toBe(30_000);
    expect(listedOnSame.targetDueNgn).toBe(0);

    const applied = applyRefundCreditToQuotation(db, {
      customerID: 'CUS-SAME',
      targetQuotationRef: 'QT-SAME-DUE',
      sourceIds: ['refund:RF-SAME-1'],
      actor,
      branchId: DEFAULT_BRANCH_ID,
      dateISO: '2026-08-03',
    });
    expect(applied.ok).toBe(true);
    expect(applied.appliedNgn).toBe(20_000);
  });
});
