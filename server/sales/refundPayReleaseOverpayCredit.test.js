/**
 * Till/bank pay of an overpayment refund frees residual (confirm-payment credit and/or
 * conflicting unpaid overpay refunds) so the payout can post.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDatabase } from '../db.js';
import { applyRefundCreditToQuotation } from '../refundCreditApplyOps.js';
import { insertLedgerRows, payRefundEntry, syncQuotationPaidFromLedger } from '../writeOps.js';
import { REFUND_CREDIT_REVERSED_STATUS } from '../../shared/lib/refundCreditApply.js';
import { DEFAULT_BRANCH_ID } from '../branches.js';
import {
  quotationOverpayResidualExcludingRefund,
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

const actor = {
  id: 'u-fin',
  displayName: 'Finance One',
  roleKey: 'finance',
  permissions: ['finance.pay', 'finance.reverse', '*'],
};

function seedOverpayFixture(db, { customerId, srcQuote, dstQuote, userId = 'u-fin' }) {
  const lines = JSON.stringify({
    products: [{ name: 'Roof', qty: 10, unitPrice: 10000 }],
    accessories: [],
    services: [],
  });
  db.exec(`
    INSERT INTO app_users (id, username, display_name, password_hash, role_key, created_at_iso)
    VALUES ('${userId}', 'fin-${userId}', 'Finance One', 'hash', 'finance', '2026-01-01T00:00:00.000Z');
    INSERT INTO customers (customer_id, name, branch_id)
    VALUES ('${customerId}', 'Overpay Release Customer', '${DEFAULT_BRANCH_ID}');
    INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso, branch_id)
    VALUES
      ('${srcQuote}', '${customerId}', 'Overpay Release Customer', 100000, 147450, 'Paid', 'Finished', '${lines.replace(/'/g, "''")}', '2026-09-01', '${DEFAULT_BRANCH_ID}'),
      ('${dstQuote}', '${customerId}', 'Overpay Release Customer', 40000, 0, 'Unpaid', 'Draft', '${lines.replace(/'/g, "''")}', '2026-09-02', '${DEFAULT_BRANCH_ID}');
  `);
  const treasury = db
    .prepare(
      `INSERT INTO treasury_accounts (name, account_type, opening_balance_ngn, branch_id, is_active)
       VALUES (?, 'Cash', 5_000_000, ?, 1)`
    )
    .run(`Till ${srcQuote}`, DEFAULT_BRANCH_ID);
  const treasuryAccountId = Number(treasury.lastInsertRowid);
  insertLedgerRows(
    db,
    [
      {
        type: 'RECEIPT',
        customerID: customerId,
        customerName: 'Overpay Release Customer',
        amountNgn: 100_000,
        quotationRef: srcQuote,
        atISO: '2026-09-01T12:00:00.000Z',
      },
      {
        type: 'OVERPAY_ADVANCE',
        customerID: customerId,
        customerName: 'Overpay Release Customer',
        amountNgn: 47_450,
        quotationRef: srcQuote,
        atISO: '2026-09-01T12:00:00.000Z',
      },
    ],
    DEFAULT_BRANCH_ID
  );
  syncQuotationPaidFromLedger(db, srcQuote);
  syncQuotationPaidFromLedger(db, dstQuote);
  return treasuryAccountId;
}

function insertApprovedOverpayRefund(db, { refundId, customerId, quotationRef, reason }) {
  db.prepare(
    `INSERT INTO customer_refunds (
       refund_id, customer_id, customer_name, quotation_ref, reason_category, reason,
       amount_ngn, approved_amount_ngn, status, requested_by, requested_at_iso,
       reviewed_by, reviewed_at_iso, paid_amount_ngn, branch_id, calculation_lines_json
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    refundId,
    customerId,
    'Overpay Release Customer',
    quotationRef,
    '["Overpayment"]',
    reason,
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
}

describe.skipIf(!mysqlOk)('pay overpayment refund releases confirm-payment credit', () => {
  let db;
  let treasuryAccountId;

  beforeAll(() => {
    db = createDatabase(':memory:');
    treasuryAccountId = seedOverpayFixture(db, {
      customerId: 'CUS-OP-REL',
      srcQuote: 'QT-OP-SRC',
      dstQuote: 'QT-OP-DST',
    });
  }, 120_000);

  afterAll(() => {
    db?.close();
  });

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

    insertApprovedOverpayRefund(db, {
      refundId: 'RF-OP-PAY',
      customerId: 'CUS-OP-REL',
      quotationRef: 'QT-OP-SRC',
      reason: 'Customer overpaid',
    });

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

    const rf = db
      .prepare(`SELECT status, paid_amount_ngn, payment_note FROM customer_refunds WHERE refund_id = 'RF-OP-PAY'`)
      .get();
    expect(String(rf.status)).toBe('Paid');
    expect(Number(rf.paid_amount_ngn)).toBe(47_450);
    expect(String(rf.payment_note || '')).toMatch(/Undid|confirm-payment credit/i);

    const dst = db.prepare(`SELECT paid_ngn FROM quotations WHERE id = 'QT-OP-DST'`).get();
    expect(Number(dst.paid_ngn)).toBe(0);
  });
});

describe.skipIf(!mysqlOk)('pay overpayment refund cancels conflicting unpaid overpay', () => {
  let db;
  let treasuryAccountId;

  beforeAll(() => {
    db = createDatabase(':memory:');
    treasuryAccountId = seedOverpayFixture(db, {
      customerId: 'CUS-OP-CON',
      srcQuote: 'QT-OP-CON',
      dstQuote: 'QT-OP-CON-DST',
      userId: 'u-fin-con',
    });
  }, 120_000);

  afterAll(() => {
    db?.close();
  });

  it('cancels conflicting unpaid overpay refund then allows till payout', () => {
    insertApprovedOverpayRefund(db, {
      refundId: 'RF-OP-OTHER',
      customerId: 'CUS-OP-CON',
      quotationRef: 'QT-OP-CON',
      reason: 'Duplicate overpay claim',
    });
    insertApprovedOverpayRefund(db, {
      refundId: 'RF-OP-KEEP',
      customerId: 'CUS-OP-CON',
      quotationRef: 'QT-OP-CON',
      reason: 'Real overpay payout',
    });

    expect(quotationOverpayResidualExcludingRefund(db, 'QT-OP-CON', 'RF-OP-KEEP')).toBe(0);

    const paid = payRefundEntry(
      db,
      'RF-OP-KEEP',
      {
        actor: { ...actor, id: 'u-fin-con' },
        paidBy: 'Finance One',
        paymentNote: 'Outside bank transfer already sent',
        paidAtISO: '2026-09-21',
        paymentLines: [{ treasuryAccountId, amountNgn: 47_450, reference: 'MON-KEEP' }],
        workspaceBranchId: DEFAULT_BRANCH_ID,
        workspaceViewAll: true,
      }
    );
    expect(paid.ok).toBe(true);
    expect(paid.fullyPaid).toBe(true);
    expect(paid.cancelledConflictingOverpayRefunds?.some((r) => r.refundId === 'RF-OP-OTHER')).toBe(
      true
    );

    const other = db.prepare(`SELECT status FROM customer_refunds WHERE refund_id = 'RF-OP-OTHER'`).get();
    expect(String(other.status)).toBe('Cancelled');
    const keep = db
      .prepare(`SELECT status, paid_amount_ngn FROM customer_refunds WHERE refund_id = 'RF-OP-KEEP'`)
      .get();
    expect(String(keep.status)).toBe('Paid');
    expect(Number(keep.paid_amount_ngn)).toBe(47_450);
  });
});

describe.skipIf(!mysqlOk)('pay overpayment when residual shows only a slice left (₦8,925 case)', () => {
  let db;
  let treasuryAccountId;

  beforeAll(() => {
    db = createDatabase(':memory:');
    // Excess ₦56,375: paying ₦47,450 leaves residual ₦8,925 while a competing Approved claim reserves ₦47,450.
    const lines = JSON.stringify({
      products: [{ name: 'Roof', qty: 10, unitPrice: 10000 }],
      accessories: [],
      services: [],
    });
    db.exec(`
      INSERT INTO app_users (id, username, display_name, password_hash, role_key, created_at_iso)
      VALUES ('u-fin-slice', 'fin-slice', 'Finance One', 'hash', 'finance', '2026-01-01T00:00:00.000Z');
      INSERT INTO customers (customer_id, name, branch_id)
      VALUES ('CUS-OP-SLICE', 'Slice Customer', '${DEFAULT_BRANCH_ID}');
      INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso, branch_id)
      VALUES
        ('QT-OP-SLICE', 'CUS-OP-SLICE', 'Slice Customer', 100000, 156375, 'Paid', 'Finished', '${lines.replace(/'/g, "''")}', '2026-09-01', '${DEFAULT_BRANCH_ID}'),
        ('QT-OP-SLICE-DST', 'CUS-OP-SLICE', 'Slice Customer', 40000, 0, 'Unpaid', 'Draft', '${lines.replace(/'/g, "''")}', '2026-09-02', '${DEFAULT_BRANCH_ID}');
    `);
    const treasury = db
      .prepare(
        `INSERT INTO treasury_accounts (name, account_type, opening_balance_ngn, branch_id, is_active)
         VALUES (?, 'Cash', 5_000_000, ?, 1)`
      )
      .run('Till slice', DEFAULT_BRANCH_ID);
    treasuryAccountId = Number(treasury.lastInsertRowid);
    insertLedgerRows(
      db,
      [
        {
          type: 'RECEIPT',
          customerID: 'CUS-OP-SLICE',
          customerName: 'Slice Customer',
          amountNgn: 100_000,
          quotationRef: 'QT-OP-SLICE',
          atISO: '2026-09-01T12:00:00.000Z',
        },
        {
          type: 'OVERPAY_ADVANCE',
          customerID: 'CUS-OP-SLICE',
          customerName: 'Slice Customer',
          amountNgn: 56_375,
          quotationRef: 'QT-OP-SLICE',
          atISO: '2026-09-01T12:00:00.000Z',
        },
      ],
      DEFAULT_BRANCH_ID
    );
    syncQuotationPaidFromLedger(db, 'QT-OP-SLICE');
  }, 120_000);

  afterAll(() => {
    db?.close();
  });

  it('cancels the competing ₦47,450 claim so till pay of ₦47,450 succeeds (was blocked as only ₦8,925 left)', () => {
    insertApprovedOverpayRefund(db, {
      refundId: 'RF-OP-SLICE-OTHER',
      customerId: 'CUS-OP-SLICE',
      quotationRef: 'QT-OP-SLICE',
      reason: 'Competing overpay',
    });
    // Competing claim already "used" as credit on another quote — old settle check blocked cancel.
    db.prepare(
      `UPDATE customer_refunds SET credit_applied_ngn = 10000 WHERE refund_id = 'RF-OP-SLICE-OTHER'`
    ).run();
    insertApprovedOverpayRefund(db, {
      refundId: 'RF-OP-SLICE-PAY',
      customerId: 'CUS-OP-SLICE',
      quotationRef: 'QT-OP-SLICE',
      reason: 'Customer already paid outside ERP',
    });

    expect(quotationOverpayResidualExcludingRefund(db, 'QT-OP-SLICE', 'RF-OP-SLICE-PAY')).toBe(8_925);

    const paid = payRefundEntry(db, 'RF-OP-SLICE-PAY', {
      actor: { ...actor, id: 'u-fin-slice' },
      paidBy: 'Finance One',
      paymentNote: 'Moniepoint already sent',
      paidAtISO: '2026-09-21',
      paymentLines: [{ treasuryAccountId, amountNgn: 47_450, reference: 'MON-SLICE' }],
      workspaceBranchId: DEFAULT_BRANCH_ID,
      workspaceViewAll: true,
    });
    expect(paid.ok).toBe(true);
    expect(paid.fullyPaid).toBe(true);
    expect(paid.cancelledConflictingOverpayRefunds?.some((r) => r.refundId === 'RF-OP-SLICE-OTHER')).toBe(
      true
    );

    const other = db
      .prepare(`SELECT status FROM customer_refunds WHERE refund_id = 'RF-OP-SLICE-OTHER'`)
      .get();
    expect(String(other.status)).toBe('Cancelled');
  });
});

describe.skipIf(!mysqlOk)('multi-reason refund pay uses Overpayment line residual only', () => {
  let db;
  let treasuryAccountId;

  beforeAll(() => {
    db = createDatabase(':memory:');
    // Quote ₦485k, cash in ₦500k → overpay ₦15k. Multi-reason refund ₦201k (overpay 15k + commission 186k).
    const lines = JSON.stringify({
      products: [{ name: 'Roof', qty: 10, unitPrice: 48500 }],
      accessories: [],
      services: [],
    });
    db.exec(`
      INSERT INTO app_users (id, username, display_name, password_hash, role_key, created_at_iso)
      VALUES ('u-fin-multi', 'fin-multi', 'Finance One', 'hash', 'finance', '2026-01-01T00:00:00.000Z');
      INSERT INTO customers (customer_id, name, branch_id)
      VALUES ('CUS-OP-MULTI', 'Multi Reason Customer', '${DEFAULT_BRANCH_ID}');
      INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso, branch_id)
      VALUES
        ('QT-OP-MULTI', 'CUS-OP-MULTI', 'Multi Reason Customer', 485000, 500000, 'Paid', 'Finished', '${lines.replace(/'/g, "''")}', '2026-09-01', '${DEFAULT_BRANCH_ID}');
    `);
    const treasury = db
      .prepare(
        `INSERT INTO treasury_accounts (name, account_type, opening_balance_ngn, branch_id, is_active)
         VALUES (?, 'Cash', 5_000_000, ?, 1)`
      )
      .run('Till multi', DEFAULT_BRANCH_ID);
    treasuryAccountId = Number(treasury.lastInsertRowid);
    insertLedgerRows(
      db,
      [
        {
          type: 'RECEIPT',
          customerID: 'CUS-OP-MULTI',
          customerName: 'Multi Reason Customer',
          amountNgn: 485_000,
          quotationRef: 'QT-OP-MULTI',
          atISO: '2026-09-01T12:00:00.000Z',
        },
        {
          type: 'OVERPAY_ADVANCE',
          customerID: 'CUS-OP-MULTI',
          customerName: 'Multi Reason Customer',
          amountNgn: 15_000,
          quotationRef: 'QT-OP-MULTI',
          atISO: '2026-09-01T12:00:00.000Z',
        },
      ],
      DEFAULT_BRANCH_ID
    );
    syncQuotationPaidFromLedger(db, 'QT-OP-MULTI');
  }, 120_000);

  afterAll(() => {
    db?.close();
  });

  it('pays ₦201k when overpayment residual is only ₦15k (other reasons are not overpay)', () => {
    const calcLines = [
      { category: 'Overpayment', amountNgn: 15_000, label: 'Overpay' },
      { category: 'Customer commission', amountNgn: 186_000, label: 'Commission' },
    ];
    db.prepare(
      `INSERT INTO customer_refunds (
         refund_id, customer_id, customer_name, quotation_ref, reason_category, reason,
         amount_ngn, approved_amount_ngn, status, requested_by, requested_at_iso,
         reviewed_by, reviewed_at_iso, paid_amount_ngn, branch_id, calculation_lines_json
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      'RF-OP-MULTI',
      'CUS-OP-MULTI',
      'Multi Reason Customer',
      'QT-OP-MULTI',
      JSON.stringify(['Overpayment', 'Customer commission']),
      'Mixed refund',
      201_000,
      201_000,
      'Approved',
      'Sales',
      '2026-09-04T10:00:00.000Z',
      'Manager',
      '2026-09-04T11:00:00.000Z',
      0,
      DEFAULT_BRANCH_ID,
      JSON.stringify(calcLines)
    );

    expect(quotationOverpayResidualExcludingRefund(db, 'QT-OP-MULTI', 'RF-OP-MULTI')).toBe(15_000);

    const paid = payRefundEntry(db, 'RF-OP-MULTI', {
      actor: { ...actor, id: 'u-fin-multi' },
      paidBy: 'Finance One',
      paymentNote: 'Multi-reason till payout',
      paidAtISO: '2026-09-21',
      paymentLines: [{ treasuryAccountId, amountNgn: 201_000, reference: 'MON-MULTI' }],
      workspaceBranchId: DEFAULT_BRANCH_ID,
      workspaceViewAll: true,
    });
    expect(paid.ok).toBe(true);
    expect(paid.fullyPaid).toBe(true);
    expect(paid.code).not.toBe('REFUND_OVERPAYMENT_ALREADY_SETTLED');

    const row = db
      .prepare(`SELECT status, paid_amount_ngn FROM customer_refunds WHERE refund_id = 'RF-OP-MULTI'`)
      .get();
    expect(String(row.status)).toBe('Paid');
    expect(Number(row.paid_amount_ngn)).toBe(201_000);
  });
});
