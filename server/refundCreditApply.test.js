import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDatabase } from './db.js';
import {
  applyRefundCreditToQuotation,
  listEligibleRefundCredits,
  listRefundCreditApplications,
  reverseRefundCreditApplication,
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

  it('consumes Pending overpayment refund without manager approval and leaves leftover Pending', () => {
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
    expect(rf.status).toBe('Pending');
    expect(Number(rf.paid_amount_ngn)).toBe(0);
    expect(Number(rf.approved_amount_ngn) || 0).toBe(0);
    expect(Number(rf.credit_applied_ngn)).toBe(30_000);
    expect(rf.credit_confirmation_status).toBe(REFUND_CREDIT_CONFIRMATION_STATUS);
    expect(rf.credit_applied_to_quotation_ref).toBe('QT-RF-DST');
    expect(String(rf.payment_note || '')).toMatch(/30,000/);
    expect(String(rf.payment_note || '')).toMatch(/awaits approval/i);

    const leftoverOverpay = overpayCreditRemainingOnQuotationDb(db, 'CUS-RC', 'QT-RF-SRC');
    expect(leftoverOverpay).toBe(10_000);
  });

  it('reverses a mistaken apply and restores the refund and target quote', () => {
    const apps = listRefundCreditApplications(db, 'CUS-RC', 'ALL', { targetQuotationRef: 'QT-RF-DST' });
    const app = apps.find((a) => a.refundId === 'RF-OVER-1' && a.status === REFUND_CREDIT_CONFIRMATION_STATUS);
    expect(app).toBeTruthy();

    const dstBefore = db.prepare(`SELECT paid_ngn FROM quotations WHERE id = 'QT-RF-DST'`).get();
    expect(Number(dstBefore?.paid_ngn)).toBe(30_000);

    const reversed = reverseRefundCreditApplication(db, app.applicationId, { actor });
    expect(reversed.ok).toBe(true);
    expect(reversed.amountNgn).toBe(30_000);

    const rf = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = 'RF-OVER-1'`).get();
    expect(rf.status).toBe('Pending');
    expect(Number(rf.credit_applied_ngn)).toBe(0);
    expect(rf.credit_applied_to_quotation_ref).toBeFalsy();
    expect(Number(rf.paid_amount_ngn)).toBe(0);

    const dstAfter = db.prepare(`SELECT paid_ngn, payment_status FROM quotations WHERE id = 'QT-RF-DST'`).get();
    expect(Number(dstAfter?.paid_ngn)).toBe(0);

    const leftoverOverpay = overpayCreditRemainingOnQuotationDb(db, 'CUS-RC', 'QT-RF-SRC');
    expect(leftoverOverpay).toBe(40_000);

    const again = reverseRefundCreditApplication(db, app.applicationId, { actor });
    expect(again.ok).toBe(false);
    expect(again.code).toBe('ALREADY_REVERSED');
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

  it('lists and applies credit from two approved overpay refunds on different quotations', () => {
    const lines = JSON.stringify({
      products: [{ name: 'Roof', qty: 8, unitPrice: 10000 }],
      accessories: [],
      services: [],
    });
    db.exec(`
      INSERT INTO customers (customer_id, name, branch_id)
      VALUES ('CUS-TWO', 'Two Refund Customer', '${DEFAULT_BRANCH_ID}');
      INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso, branch_id)
      VALUES
        ('QT-TWO-A', 'CUS-TWO', 'Two Refund Customer', 60000, 90000, 'Paid', 'Finished', '${lines.replace(/'/g, "''")}', '2026-09-01', '${DEFAULT_BRANCH_ID}'),
        ('QT-TWO-B', 'CUS-TWO', 'Two Refund Customer', 50000, 80000, 'Paid', 'Finished', '${lines.replace(/'/g, "''")}', '2026-09-02', '${DEFAULT_BRANCH_ID}'),
        ('QT-TWO-DST', 'CUS-TWO', 'Two Refund Customer', 70000, 0, 'Unpaid', 'Draft', '${lines.replace(/'/g, "''")}', '2026-09-03', '${DEFAULT_BRANCH_ID}');
      INSERT INTO customer_refunds (
        refund_id, customer_id, customer_name, quotation_ref, reason_category, reason,
        amount_ngn, status, requested_by, requested_at_iso, approved_amount_ngn, paid_amount_ngn, branch_id,
        calculation_lines_json
      ) VALUES
        ('RF-TWO-A', 'CUS-TWO', 'Two Refund Customer', 'QT-TWO-A', '["Overpayment"]', 'Overpay A',
         30000, 'Approved', 'Sales One', '2026-09-01T10:00:00.000Z', 30000, 0, '${DEFAULT_BRANCH_ID}',
         '${JSON.stringify([{ category: 'Overpayment', amountNgn: 30000, label: 'Overpay A' }]).replace(/'/g, "''")}'),
        ('RF-TWO-B', 'CUS-TWO', 'Two Refund Customer', 'QT-TWO-B', '["Overpayment"]', 'Overpay B',
         25000, 'Approved', 'Sales One', '2026-09-02T10:00:00.000Z', 25000, 0, '${DEFAULT_BRANCH_ID}',
         '${JSON.stringify([{ category: 'Overpayment', amountNgn: 25000, label: 'Overpay B' }]).replace(/'/g, "''")}');
    `);

    const listed = listEligibleRefundCredits(db, 'CUS-TWO', 'QT-TWO-DST');
    expect(listed.ok).toBe(true);
    expect(listed.sources.filter((s) => s.kind === 'refund')).toHaveLength(2);
    expect(listed.totalAvailableNgn).toBe(55_000);
    expect(listed.recommendedApplyNgn).toBe(55_000);

    const applied = applyRefundCreditToQuotation(db, {
      customerID: 'CUS-TWO',
      targetQuotationRef: 'QT-TWO-DST',
      amountNgn: 55_000,
      sourceIds: ['refund:RF-TWO-A', 'refund:RF-TWO-B'],
      actor,
      branchId: DEFAULT_BRANCH_ID,
      dateISO: '2026-09-04',
    });
    expect(applied.ok).toBe(true);
    expect(applied.appliedNgn).toBe(55_000);
    expect(applied.applications).toHaveLength(2);

    const rfA = db.prepare(`SELECT credit_applied_ngn FROM customer_refunds WHERE refund_id = 'RF-TWO-A'`).get();
    const rfB = db.prepare(`SELECT credit_applied_ngn FROM customer_refunds WHERE refund_id = 'RF-TWO-B'`).get();
    expect(Number(rfA.credit_applied_ngn)).toBe(30_000);
    expect(Number(rfB.credit_applied_ngn)).toBe(25_000);
  });

  it('lists two overpay refunds when the second row has a mismatched customer_id but quotation matches', () => {
    const lines = JSON.stringify({
      products: [{ name: 'Roof', qty: 5, unitPrice: 10000 }],
      accessories: [],
      services: [],
    });
    db.exec(`
      INSERT INTO customers (customer_id, name, branch_id)
      VALUES
        ('CUS-MIX', 'Mixed Id Customer', '${DEFAULT_BRANCH_ID}'),
        ('CUS-LEGACY', 'Legacy Row Customer', '${DEFAULT_BRANCH_ID}');
      INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso, branch_id)
      VALUES
        ('QT-MIX-A', 'CUS-MIX', 'Mixed Id Customer', 50000, 70000, 'Paid', 'Finished', '${lines.replace(/'/g, "''")}', '2026-10-01', '${DEFAULT_BRANCH_ID}'),
        ('QT-MIX-B', 'CUS-MIX', 'Mixed Id Customer', 50000, 70000, 'Paid', 'Finished', '${lines.replace(/'/g, "''")}', '2026-10-02', '${DEFAULT_BRANCH_ID}'),
        ('QT-MIX-DST', 'CUS-MIX', 'Mixed Id Customer', 40000, 0, 'Unpaid', 'Draft', '${lines.replace(/'/g, "''")}', '2026-10-03', '${DEFAULT_BRANCH_ID}');
      INSERT INTO customer_refunds (
        refund_id, customer_id, customer_name, quotation_ref, reason_category, reason,
        amount_ngn, status, requested_by, requested_at_iso, branch_id, calculation_lines_json
      ) VALUES
        ('RF-MIX-A', 'CUS-MIX', 'Mixed Id Customer', 'QT-MIX-A', '["Overpayment"]', 'Overpay A',
         15000, 'Pending', 'Sales One', '2026-10-01T10:00:00.000Z', '${DEFAULT_BRANCH_ID}',
         '${JSON.stringify([{ category: 'Overpayment', amountNgn: 15000 }]).replace(/'/g, "''")}'),
        ('RF-MIX-B', 'CUS-LEGACY', 'Mixed Id Customer', 'QT-MIX-B', '["Overpayment"]', 'Overpay B',
         12000, 'Pending', 'Sales One', '2026-10-02T10:00:00.000Z', '${DEFAULT_BRANCH_ID}',
         '${JSON.stringify([{ category: 'Overpayment', amountNgn: 12000 }]).replace(/'/g, "''")}');
    `);

    const listed = listEligibleRefundCredits(db, 'CUS-MIX', 'QT-MIX-DST');
    expect(listed.ok).toBe(true);
    expect(listed.sources.filter((s) => s.kind === 'refund')).toHaveLength(2);
    expect(listed.totalAvailableNgn).toBe(27_000);
  });

  it('shows ledger overpay excess on a quote that already has a partial overpay refund', () => {
    const lines = JSON.stringify({
      products: [{ name: 'Roof', qty: 10, unitPrice: 10000 }],
      accessories: [],
      services: [],
    });
    db.exec(`
      INSERT INTO customers (customer_id, name, branch_id)
      VALUES ('CUS-PART', 'Partial Overpay Customer', '${DEFAULT_BRANCH_ID}');
      INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso, branch_id)
      VALUES
        ('QT-PART-SRC', 'CUS-PART', 'Partial Overpay Customer', 100000, 150000, 'Paid', 'Finished', '${lines.replace(/'/g, "''")}', '2026-11-01', '${DEFAULT_BRANCH_ID}'),
        ('QT-PART-DST', 'CUS-PART', 'Partial Overpay Customer', 60000, 0, 'Unpaid', 'Draft', '${lines.replace(/'/g, "''")}', '2026-11-02', '${DEFAULT_BRANCH_ID}');
    `);
    insertLedgerRows(
      db,
      [
        {
          type: 'RECEIPT',
          customerID: 'CUS-PART',
          customerName: 'Partial Overpay Customer',
          amountNgn: 100_000,
          quotationRef: 'QT-PART-SRC',
          atISO: '2026-11-01T10:00:00.000Z',
        },
        {
          type: 'OVERPAY_ADVANCE',
          customerID: 'CUS-PART',
          customerName: 'Partial Overpay Customer',
          amountNgn: 50_000,
          quotationRef: 'QT-PART-SRC',
          atISO: '2026-11-01T10:30:00.000Z',
        },
      ],
      DEFAULT_BRANCH_ID
    );
    db.exec(`
      INSERT INTO customer_refunds (
        refund_id, customer_id, customer_name, quotation_ref, reason_category, reason,
        amount_ngn, status, requested_by, requested_at_iso, branch_id, calculation_lines_json
      ) VALUES (
        'RF-PART-1', 'CUS-PART', 'Partial Overpay Customer', 'QT-PART-SRC', '["Overpayment"]', 'Partial overpay refund',
        30000, 'Pending', 'Sales One', '2026-11-01T11:00:00.000Z', '${DEFAULT_BRANCH_ID}',
        '${JSON.stringify([{ category: 'Overpayment', amountNgn: 30000 }]).replace(/'/g, "''")}'
      );
    `);

    const listed = listEligibleRefundCredits(db, 'CUS-PART', 'QT-PART-DST');
    expect(listed.ok).toBe(true);
    expect(listed.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'refund', refundId: 'RF-PART-1', availableNgn: 30_000 }),
        expect.objectContaining({ kind: 'overpay', sourceQuotationRef: 'QT-PART-SRC', availableNgn: 20_000 }),
      ])
    );
    expect(listed.totalAvailableNgn).toBe(50_000);
  });

  it('lists approved overpay refund with partial treasury payout (open balance remains)', () => {
    const lines = JSON.stringify({
      products: [{ name: 'Roof', qty: 6, unitPrice: 10000 }],
      accessories: [],
      services: [],
    });
    db.exec(`
      INSERT INTO customers (customer_id, name, branch_id)
      VALUES ('CUS-PARTIAL', 'Partial Pay Customer', '${DEFAULT_BRANCH_ID}');
      INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso, branch_id)
      VALUES
        ('QT-PARTIAL-SRC', 'CUS-PARTIAL', 'Partial Pay Customer', 60000, 121000, 'Paid', 'Finished', '${lines.replace(/'/g, "''")}', '2026-12-01', '${DEFAULT_BRANCH_ID}'),
        ('QT-PARTIAL-DST', 'CUS-PARTIAL', 'Partial Pay Customer', 95200, 0, 'Unpaid', 'Draft', '${lines.replace(/'/g, "''")}', '2026-12-02', '${DEFAULT_BRANCH_ID}');
    `);
    insertLedgerRows(
      db,
      [
        {
          type: 'RECEIPT',
          customerID: 'CUS-PARTIAL',
          customerName: 'Partial Pay Customer',
          amountNgn: 60_000,
          quotationRef: 'QT-PARTIAL-SRC',
          atISO: '2026-12-01T10:00:00.000Z',
        },
        {
          type: 'OVERPAY_ADVANCE',
          customerID: 'CUS-PARTIAL',
          customerName: 'Partial Pay Customer',
          amountNgn: 61_000,
          quotationRef: 'QT-PARTIAL-SRC',
          atISO: '2026-12-01T10:30:00.000Z',
        },
      ],
      DEFAULT_BRANCH_ID
    );
    db.exec(`
      INSERT INTO customer_refunds (
        refund_id, customer_id, customer_name, quotation_ref, reason_category, reason,
        amount_ngn, status, requested_by, requested_at_iso, approved_amount_ngn, paid_amount_ngn, branch_id,
        calculation_lines_json
      ) VALUES (
        'RF-PARTIAL-61', 'CUS-PARTIAL', 'Partial Pay Customer', 'QT-PARTIAL-SRC', '["Overpayment"]', 'Overpay partial pay',
        61000, 'Approved', 'Sales One', '2026-12-01T10:00:00.000Z', 61000, 34000, '${DEFAULT_BRANCH_ID}',
        '${JSON.stringify([{ category: 'Overpayment', amountNgn: 61000 }]).replace(/'/g, "''")}'
      );
    `);

    const listed = listEligibleRefundCredits(db, 'CUS-PARTIAL', 'QT-PARTIAL-DST');
    expect(listed.ok).toBe(true);
    const rf = listed.sources.find((s) => s.refundId === 'RF-PARTIAL-61');
    expect(rf).toBeTruthy();
    expect(rf.availableNgn).toBe(27_000);
    expect(listed.totalAvailableNgn).toBeGreaterThanOrEqual(27_000);
  });

  it('lists full-receipt overpay as credit without OVERPAY_ADVANCE or a refund request', () => {
    const lines = JSON.stringify({
      products: [{ name: 'Roof', qty: 2, unitPrice: 10000 }],
      accessories: [],
      services: [],
    });
    db.exec(`
      INSERT INTO customers (customer_id, name, branch_id)
      VALUES ('CUS-ECON', 'Economic Overpay Customer', '${DEFAULT_BRANCH_ID}');
      INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso, branch_id)
      VALUES
        ('QT-ECON-SRC', 'CUS-ECON', 'Economic Overpay Customer', 100000, 150000, 'Paid', 'Finished', '${lines.replace(/'/g, "''")}', '2026-08-01', '${DEFAULT_BRANCH_ID}'),
        ('QT-ECON-DST', 'CUS-ECON', 'Economic Overpay Customer', 40000, 0, 'Unpaid', 'Draft', '${lines.replace(/'/g, "''")}', '2026-08-02', '${DEFAULT_BRANCH_ID}');
      INSERT INTO ledger_entries (id, type, customer_id, customer_name, quotation_ref, amount_ngn, at_iso, branch_id)
      VALUES ('LE-ECON-1', 'RECEIPT', 'CUS-ECON', 'Economic Overpay Customer', 'QT-ECON-SRC', 150000, '2026-08-01T12:00:00.000Z', '${DEFAULT_BRANCH_ID}');
      INSERT INTO sales_receipts (id, customer_id, customer_name, quotation_ref, amount_ngn, amount_display, status, date_iso, ledger_entry_id)
      VALUES ('LE-ECON-1', 'CUS-ECON', 'Economic Overpay Customer', 'QT-ECON-SRC', 150000, '₦150,000', 'Cleared', '2026-08-01', 'LE-ECON-1');
    `);

    const listed = listEligibleRefundCredits(db, 'CUS-ECON', 'QT-ECON-DST');
    expect(listed.ok).toBe(true);
    const src = listed.sources.find((s) => s.id === 'overpay:QT-ECON-SRC');
    expect(src).toBeTruthy();
    expect(src.kind).toBe('overpay');
    expect(src.availableNgn).toBe(50_000);
    expect(src.refundId).toBeNull();
    expect(listed.recommendedApplyNgn).toBe(40_000);

    const applied = applyRefundCreditToQuotation(db, {
      customerID: 'CUS-ECON',
      targetQuotationRef: 'QT-ECON-DST',
      sourceIds: ['overpay:QT-ECON-SRC'],
      actor,
      branchId: DEFAULT_BRANCH_ID,
      dateISO: '2026-08-03',
    });
    expect(applied.ok).toBe(true);
    expect(applied.appliedNgn).toBe(40_000);

    const listedAfter = listEligibleRefundCredits(db, 'CUS-ECON', 'QT-ECON-DST');
    const leftover = listedAfter.sources.find((s) => s.id === 'overpay:QT-ECON-SRC');
    expect(leftover?.availableNgn ?? 0).toBe(10_000);
  });

  it('does not list leftover overpay after the refund was till-paid (QT-1173 / RF-9456)', () => {
    const lines = JSON.stringify({
      products: [{ name: 'Roof', qty: 1, unitPrice: 12228500 }],
      accessories: [],
      services: [],
    });
    db.exec(`
      INSERT INTO customers (customer_id, name, branch_id)
      VALUES ('CUS-1173', 'Engr Yaro', '${DEFAULT_BRANCH_ID}');
      INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso, branch_id)
      VALUES
        ('QT-KD-26-1173', 'CUS-1173', 'Engr Yaro', 12228500, 13000000, 'Paid', 'Finished', '${lines.replace(/'/g, "''")}', '2026-08-08', '${DEFAULT_BRANCH_ID}'),
        ('QT-KD-26-NEXT', 'CUS-1173', 'Engr Yaro', 500000, 0, 'Unpaid', 'Draft', '${lines.replace(/'/g, "''")}', '2026-08-20', '${DEFAULT_BRANCH_ID}');
      INSERT INTO ledger_entries (id, type, customer_id, customer_name, quotation_ref, amount_ngn, at_iso, branch_id)
      VALUES ('LE-KD-26-1366', 'RECEIPT', 'CUS-1173', 'Engr Yaro', 'QT-KD-26-1173', 13000000, '2026-08-15T12:00:00.000Z', '${DEFAULT_BRANCH_ID}');
      INSERT INTO sales_receipts (id, customer_id, customer_name, quotation_ref, amount_ngn, amount_display, status, date_iso, ledger_entry_id)
      VALUES ('LE-KD-26-1366', 'CUS-1173', 'Engr Yaro', 'QT-KD-26-1173', 13000000, '₦13,000,000', 'Cleared', '2026-08-15', 'LE-KD-26-1366');
      INSERT INTO customer_refunds (
        refund_id, customer_id, customer_name, quotation_ref, reason_category, reason,
        amount_ngn, status, requested_by, requested_at_iso, approved_amount_ngn, paid_amount_ngn,
        paid_at_iso, paid_by, payee_name, payee_bank_name, credit_applied_ngn, branch_id,
        calculation_lines_json
      ) VALUES (
        'RF-KD-26-9456', 'CUS-1173', 'Engr Yaro', 'QT-KD-26-1173', '["Overpayment"]', 'Overpayment',
        771500, 'Approved', 'Zarewa Admin', '2026-08-08T10:00:00.000Z', 771500, 771500,
        '2026-08-08', 'Zarewa Admin', 'Abdulrahman', 'OPAY', 0, '${DEFAULT_BRANCH_ID}',
        '${JSON.stringify([{ category: 'Overpayment', amountNgn: 771500 }]).replace(/'/g, "''")}'
      );
    `);

    const listed = listEligibleRefundCredits(db, 'CUS-1173', 'QT-KD-26-NEXT');
    expect(listed.ok).toBe(true);
    expect(listed.sources.find((s) => s.id === 'overpay:QT-KD-26-1173')).toBeUndefined();
    expect(listed.sources.some((s) => s.refundId === 'RF-KD-26-9456')).toBe(false);
    const paidOut = listed.unavailableSources.find((s) => s.refundId === 'RF-KD-26-9456');
    expect(paidOut).toBeTruthy();
    expect(String(paidOut.reason || '')).toMatch(/already paid out/i);
    expect(listed.totalAvailableNgn).toBe(0);
  });

  it('applies overpay onto a manager-cleared quotation that still has an unconfirmed receipt', () => {
    const lines = JSON.stringify({
      products: [{ name: 'Roof', qty: 2, unitPrice: 10000 }],
      accessories: [],
      services: [],
    });
    db.exec(`
      INSERT INTO customers (customer_id, name, branch_id)
      VALUES ('CUS-CLR', 'Cleared Overpay Customer', '${DEFAULT_BRANCH_ID}');
      INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso, branch_id, manager_cleared_at_iso)
      VALUES
        ('QT-CLR-SRC', 'CUS-CLR', 'Cleared Overpay Customer', 100000, 150000, 'Paid', 'Finished', '${lines.replace(/'/g, "''")}', '2026-08-01', '${DEFAULT_BRANCH_ID}', '2026-08-02T12:00:00.000Z'),
        ('QT-CLR-DST', 'CUS-CLR', 'Cleared Overpay Customer', 40000, 40000, 'Paid', 'Draft', '${lines.replace(/'/g, "''")}', '2026-08-02', '${DEFAULT_BRANCH_ID}', '2026-08-02T12:00:00.000Z');
      INSERT INTO ledger_entries (id, type, customer_id, customer_name, quotation_ref, amount_ngn, at_iso, branch_id)
      VALUES
        ('LE-CLR-SRC', 'OVERPAY_ADVANCE', 'CUS-CLR', 'Cleared Overpay Customer', 'QT-CLR-SRC', 50000, '2026-08-01T12:00:00.000Z', '${DEFAULT_BRANCH_ID}'),
        ('LE-CLR-DST', 'RECEIPT', 'CUS-CLR', 'Cleared Overpay Customer', 'QT-CLR-DST', 40000, '2026-08-02T12:00:00.000Z', '${DEFAULT_BRANCH_ID}');
      INSERT INTO sales_receipts (id, customer_id, customer_name, quotation_ref, amount_ngn, amount_display, status, date_iso, ledger_entry_id)
      VALUES ('LE-CLR-DST', 'CUS-CLR', 'Cleared Overpay Customer', 'QT-CLR-DST', 40000, '₦40,000', 'Pending clearance', '2026-08-02', 'LE-CLR-DST');
    `);

    const applied = applyRefundCreditToQuotation(db, {
      customerID: 'CUS-CLR',
      targetQuotationRef: 'QT-CLR-DST',
      sourceIds: ['overpay:QT-CLR-SRC'],
      actor,
      branchId: DEFAULT_BRANCH_ID,
      dateISO: '2026-08-03',
    });
    expect(applied.ok).toBe(true);
    expect(applied.appliedNgn).toBe(40_000);
  });
});
