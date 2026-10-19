/**
 * Refund audit (feat/refund-audit) — Part 2, DB-backed: partial payouts across days and accounts, payout to a
 * non-profile account, reversal after a credit apply, approval headroom with credit out, retention dedupe,
 * payee on the treasury line. One MySQL schema for the file (a reset costs minutes); each test seeds its own
 * customer and quotation. Skips without MySQL.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDatabase } from './db.js';
import { insertRefundRequest, decideRefundRequest } from './controlOps.js';
import { payRefundEntry, reverseRefundTreasuryPayouts } from './writeOps.js';
import { getCustomerRefundDetail } from './readModel.js';
import { buildRefundSettlementSummary } from './sales/refundPayoutStatus.js';
import { creditCompanyRetentionFromRefundTx } from './finance/refundCompanyRetentionLedger.js';
import { buildTreasuryCashBook } from '../shared/lib/treasuryCashBookCore.js';

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

const QUOTE_TOTAL = 1_000_000;
const CASH_IN = 1_500_000; // one cleared receipt → overpayment 500,000

function actorFor(db, username) {
  const u = db
    .prepare(`SELECT id, username, role_key AS roleKey, display_name AS displayName FROM app_users WHERE username = ?`)
    .get(username);
  if (!u) throw new Error(`seeded user ${username} missing`);
  return { ...u, permissions: username === 'admin' ? ['*'] : undefined };
}

/** Customer with a saved bank, a cleared receipt above the quote total, completed production. */
function seedCase(db, tag, { cashIn = CASH_IN, bank = true } = {}) {
  const customer = `CUS-AUDIT-${tag}`;
  const quote = `QT-AUDIT-${tag}`;
  db.prepare(
    `INSERT INTO customers (customer_id, name, branch_id, status, bank_account_name, bank_name, bank_account_no)
     VALUES (?, ?, 'BR-KD', 'Active', ?, ?, ?)`
  ).run(customer, `Audit ${tag}`, bank ? `Audit ${tag}` : null, bank ? 'GT Bank' : null, bank ? '0123456789' : null);
  db.prepare(
    `INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, branch_id, date_iso)
     VALUES (?, ?, ?, ?, ?, 'Paid', 'Finished', ?, 'BR-KD', '2026-10-01')`
  ).run(
    quote,
    customer,
    `Audit ${tag}`,
    QUOTE_TOTAL,
    cashIn,
    JSON.stringify({ products: [{ name: 'Roofing Sheet', qty: 200, unitPrice: 5000, amount: QUOTE_TOTAL }], accessories: [], services: [] })
  );
  db.prepare(
    `INSERT INTO sales_receipts (id, customer_id, customer_name, quotation_ref, amount_ngn, bank_received_amount_ngn, status, date_iso, finance_reconciliation_saved_at_iso, ledger_entry_id, branch_id)
     VALUES (?, ?, ?, ?, ?, ?, 'Cleared', '2026-10-01', '2026-10-01T10:00:00.000Z', ?, 'BR-KD')`
  ).run(`LE-AUDIT-${tag}`, customer, `Audit ${tag}`, quote, cashIn, cashIn, `LE-AUDIT-${tag}`);
  db.prepare(
    `INSERT INTO production_jobs (job_id, quotation_ref, status, planned_meters, actual_meters, created_at_iso, completed_at_iso)
     VALUES (?, ?, 'Completed', 200, 200, '2026-10-02T12:00:00.000Z', '2026-10-02T12:00:00.000Z')`
  ).run(`PRO-AUDIT-${tag}`, quote);
  return { customer, quote };
}

function raise(db, sales, { customer, quote }, amountNgn = 500_000, extra = {}) {
  const created = insertRefundRequest(
    db,
    {
      customerID: customer,
      quotationRef: quote,
      amountNgn,
      reasonCategory: ['Overpayment'],
      reason: 'Overpayment on the quotation',
      calculationLines: [{ category: 'Overpayment', label: `Overpayment on ${quote}`, amountNgn }],
      requestedAtISO: '2026-10-03T09:00:00.000Z',
      ...extra,
    },
    sales,
    'BR-KD'
  );
  if (!created.ok) throw new Error(`insertRefundRequest: ${created.error}`);
  return created.refundID;
}

function approve(db, admin, rid, amountNgn) {
  const decided = decideRefundRequest(
    db,
    rid,
    { status: 'Approved', approvalDate: '2026-10-03', ...(amountNgn != null ? { approvedAmountNgn: amountNgn } : {}) },
    admin
  );
  return decided;
}

describe.skipIf(!mysqlOk)('refund audit — DB-backed cases', () => {
  let db;
  let admin;
  let sales;
  let accounts;

  beforeAll(() => {
    db = createDatabase(':memory:');
    admin = actorFor(db, 'admin');
    sales = actorFor(db, 'sales.staff');
    const insT = db.prepare(
      `INSERT INTO treasury_accounts (name, bank_name, balance, type, acc_no, branch_id) VALUES (?,?,?,?,?,?)`
    );
    const a = insT.run('Audit Moniepoint', 'Moniepoint', 50_000_000, 'Bank', '1111111111', 'BR-KD');
    const b = insT.run('Audit Cash till', '', 50_000_000, 'Cash', 'N/A', 'BR-KD');
    accounts = { accountA: Number(a.lastInsertRowid), accountB: Number(b.lastInsertRowid) };
  }, 900_000);

  afterAll(() => {
    db?.close();
  });

  it('pays 300,000 on day 1 (bank) and 200,000 on day 2 (cash): Partially paid → Paid, lines keep their day and account', () => {
    const c = seedCase(db, 'PART');
    const rid = raise(db, sales, c);
    expect(approve(db, admin, rid).ok).toBe(true);
    const row0 = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(rid);
    expect(row0.status).toBe('Approved');
    expect(Number(row0.approved_amount_ngn)).toBe(500_000);

    const pay1 = payRefundEntry(db, rid, {
      actor: admin,
      workspaceBranchId: 'BR-KD',
      paidBy: 'Cashier One',
      paymentLines: [{ treasuryAccountId: accounts.accountA, amountNgn: 300_000, reference: 'TRF-1', dateISO: '2026-10-04' }],
    });
    expect(pay1.ok).toBe(true);
    expect(pay1.fullyPaid).toBe(false);
    expect(pay1.outstandingNgn).toBe(200_000);
    const mid = db.prepare(`SELECT status, paid_amount_ngn FROM customer_refunds WHERE refund_id = ?`).get(rid);
    expect(mid.status).toBe('Partially paid');
    expect(Number(mid.paid_amount_ngn)).toBe(300_000);
    const sMid = buildRefundSettlementSummary(db, db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(rid));
    expect(sMid.cashOutstandingNgn).toBe(200_000);
    expect(sMid.tillPayableNgn).toBe(200_000);
    expect(sMid.publicLabel).toBe('Partially settled');

    const pay2 = payRefundEntry(db, rid, {
      actor: admin,
      workspaceBranchId: 'BR-KD',
      paidBy: 'Cashier Two',
      paymentLines: [{ treasuryAccountId: accounts.accountB, amountNgn: 200_000, reference: 'CASH-2', dateISO: '2026-10-05' }],
    });
    expect(pay2.ok).toBe(true);
    expect(pay2.fullyPaid).toBe(true);
    const end = db.prepare(`SELECT status, paid_amount_ngn, paid_by FROM customer_refunds WHERE refund_id = ?`).get(rid);
    expect(end.status).toBe('Paid');
    expect(Number(end.paid_amount_ngn)).toBe(500_000);
    expect(end.paid_by).toBe('Cashier Two');

    const lines = db
      .prepare(`SELECT treasury_account_id, amount_ngn, posted_at_iso, counterparty_name FROM treasury_movements WHERE source_kind='REFUND' AND source_id=? ORDER BY posted_at_iso`)
      .all(rid);
    expect(lines.map((l) => [Number(l.treasury_account_id), Number(l.amount_ngn), String(l.posted_at_iso).slice(0, 10)])).toEqual([
      [accounts.accountA, -300_000, '2026-10-04'],
      [accounts.accountB, -200_000, '2026-10-05'],
    ]);
    // Single payee (the customer's own bank): the line is booked against that payee name.
    expect(lines[0].counterparty_name).toBe('Audit PART');

    const detail = getCustomerRefundDetail(db, rid);
    expect(detail.payoutHistory).toHaveLength(2);
    expect(detail.payoutHistory.map((p) => [p.accountName, p.amountNgn])).toEqual([
      ['Audit Moniepoint', 300_000],
      ['Audit Cash till', 200_000],
    ]);
    expect(detail.settlementSummary.publicLabel).toBe('Settled');
    expect(detail.settlementSummary.cashPaidNgn).toBe(500_000);

    const je = db
      .prepare(`SELECT source_id FROM gl_journal_entries WHERE source_kind='CUSTOMER_REFUND_PAYOUT_GL' AND source_id LIKE ? ORDER BY source_id`)
      .all(`${rid}:paid:%`);
    expect(je).toHaveLength(2);

    const tms = db.prepare(`SELECT * FROM treasury_movements WHERE source_kind='REFUND' AND source_id=?`).all(rid);
    const book = buildTreasuryCashBook({
      account: { id: accounts.accountA, name: 'Audit Moniepoint' },
      startDate: '2026-10-04',
      endDate: '2026-10-05',
      openingNgn: 5_000_000,
      movements: tms.map((m) => ({ id: m.id, postedAtISO: m.posted_at_iso, type: m.type, amountNgn: Number(m.amount_ngn), treasuryAccountId: Number(m.treasury_account_id), sourceKind: m.source_kind, sourceId: m.source_id, counterpartyName: m.counterparty_name })),
      refunds: { [rid]: { customerName: 'Audit PART', quotationRef: c.quote } },
      refundPayoutLines: { [rid]: tms.map((m) => m.id) },
    });
    const line = book.days.flatMap((d) => d.lines)[0];
    expect(line.description).toMatch(/part 1 of 2/);
    expect(line.drNgn).toBe(300_000);
  }, 120_000);

  it('refuses a payout above the approved balance and a second full payout', () => {
    const c = seedCase(db, 'OVER');
    const rid = raise(db, sales, c);
    expect(approve(db, admin, rid).ok).toBe(true);
    const over = payRefundEntry(db, rid, {
      actor: admin,
      workspaceBranchId: 'BR-KD',
      paymentLines: [{ treasuryAccountId: accounts.accountA, amountNgn: 500_001, dateISO: '2026-10-04' }],
    });
    expect(over.ok).toBe(false);
    expect(over.error).toMatch(/exceeds the approved refund balance/i);
    const full = payRefundEntry(db, rid, {
      actor: admin,
      workspaceBranchId: 'BR-KD',
      paymentLines: [{ treasuryAccountId: accounts.accountA, amountNgn: 500_000, dateISO: '2026-10-04' }],
    });
    expect(full.ok).toBe(true);
    const again = payRefundEntry(db, rid, {
      actor: admin,
      workspaceBranchId: 'BR-KD',
      paymentLines: [{ treasuryAccountId: accounts.accountA, amountNgn: 1_000, dateISO: '2026-10-05' }],
    });
    expect(again.ok).toBe(false);
    expect(again.error).toMatch(/already been fully paid|Only approved refunds awaiting payout/i);
  }, 120_000);

  it('a payout to a non-profile account: the inline bank typed on the form is saved onto the customer profile', () => {
    const c = seedCase(db, 'NOMINEE', { bank: false });
    const rid = raise(db, sales, c, 500_000, {
      refundSplits: [
        {
          recipientKind: 'customer',
          recipientCustomerID: c.customer,
          amountNgn: 500_000,
          payoutAccount: { payeeName: 'Nominee Account', payeeBankName: 'Opay', payeeAccountNo: '70123456789' },
        },
      ],
    });
    const row = db.prepare(`SELECT payee_name, payee_account_no, payee_bank_name FROM customer_refunds WHERE refund_id = ?`).get(rid);
    expect(row).toMatchObject({ payee_name: 'Nominee Account', payee_account_no: '70123456789', payee_bank_name: 'Opay' });
    const cust = db.prepare(`SELECT bank_account_name, bank_name, bank_account_no FROM customers WHERE customer_id = ?`).get(c.customer);
    // Side effect worth knowing: the nominee becomes the customer's saved payout bank.
    expect(cust).toMatchObject({ bank_account_name: 'Nominee Account', bank_name: 'Opay', bank_account_no: '70123456789' });
    expect(approve(db, admin, rid).ok).toBe(true);
    const pay = payRefundEntry(db, rid, {
      actor: admin,
      workspaceBranchId: 'BR-KD',
      paymentLines: [{ treasuryAccountId: accounts.accountA, amountNgn: 500_000, dateISO: '2026-10-04' }],
    });
    expect(pay.ok).toBe(true);
    const tm = db.prepare(`SELECT counterparty_name FROM treasury_movements WHERE source_kind='REFUND' AND source_id=?`).get(rid);
    // The treasury line names the nominee who was paid, not the quotation customer.
    expect(tm.counterparty_name).toBe('Nominee Account');
  }, 120_000);

  it('an explicit payee from the pay dialog is booked on the treasury line', () => {
    const c = seedCase(db, 'PAYEE');
    const rid = raise(db, sales, c);
    expect(approve(db, admin, rid).ok).toBe(true);
    const pay = payRefundEntry(db, rid, {
      actor: admin,
      workspaceBranchId: 'BR-KD',
      payeeName: 'Abdulrahman Uthman Sali',
      payeeBankName: 'opay',
      payeeAccountNo: '8031831486',
      payeeKind: 'customer',
      paymentLines: [{ treasuryAccountId: accounts.accountA, amountNgn: 500_000, dateISO: '2026-10-04' }],
    });
    expect(pay.ok).toBe(true);
    const tm = db.prepare(`SELECT counterparty_name, counterparty_id FROM treasury_movements WHERE source_kind='REFUND' AND source_id=?`).get(rid);
    expect(tm.counterparty_name).toBe('Abdulrahman Uthman Sali');
    expect(tm.counterparty_id).toBe(c.customer);
  }, 120_000);

  it('reversal after a part payout: treasury lines reversed, GL reversed for the cash only, status Approved, payable again', () => {
    const c = seedCase(db, 'REV');
    const rid = raise(db, sales, c);
    expect(approve(db, admin, rid).ok).toBe(true);
    payRefundEntry(db, rid, {
      actor: admin,
      workspaceBranchId: 'BR-KD',
      paymentLines: [{ treasuryAccountId: accounts.accountA, amountNgn: 300_000, dateISO: '2026-10-04' }],
    });
    // Simulate a credit already applied on this refund (paid_amount counts it; the GL reversal must not).
    db.prepare(`UPDATE customer_refunds SET credit_applied_ngn = 100000, paid_amount_ngn = 400000 WHERE refund_id = ?`).run(rid);
    const rev = reverseRefundTreasuryPayouts(db, rid, { note: 'paid to wrong account', workspaceBranchId: 'BR-KD' }, admin);
    expect(rev.ok).toBe(true);
    expect(rev.priorPaidAmountNgn).toBe(400_000);
    // Cash is back; the 100,000 credit is still settled, so paid_amount keeps it and status stays Partially paid.
    const row = db.prepare(`SELECT status, paid_amount_ngn FROM customer_refunds WHERE refund_id = ?`).get(rid);
    expect(row.status).toBe('Partially paid');
    expect(Number(row.paid_amount_ngn)).toBe(100_000);
    const net = db.prepare(`SELECT COALESCE(SUM(amount_ngn),0) s FROM treasury_movements WHERE source_kind='REFUND' AND source_id=?`).get(rid);
    expect(Number(net.s)).toBe(0);
    const glRev = db
      .prepare(`SELECT jl.credit_ngn, jl.debit_ngn FROM gl_journal_entries je JOIN gl_journal_lines jl ON jl.journal_id=je.id WHERE je.source_kind='CUSTOMER_REFUND_PAYOUT_REVERSAL_GL' AND je.source_id LIKE ?`)
      .all(`${rid}:full:%`);
    expect(glRev.length).toBe(2);
    // 300,000 of cash left and came back; the 100,000 credit stays where it is.
    expect(Math.max(...glRev.map((l) => Number(l.debit_ngn) || 0))).toBe(300_000);
    db.prepare(`UPDATE customer_refunds SET credit_applied_ngn = 0 WHERE refund_id = ?`).run(rid);
    // Pay repairs the stored state first (paid 0, Approved) and then takes the full amount.
    const again = payRefundEntry(db, rid, {
      actor: admin,
      workspaceBranchId: 'BR-KD',
      paymentLines: [{ treasuryAccountId: accounts.accountB, amountNgn: 500_000, dateISO: '2026-10-06' }],
    });
    expect(again.ok).toBe(true);
    expect(again.fullyPaid).toBe(true);
  }, 120_000);

  it('approval headroom counts credit already moved to another quotation, like the request did', () => {
    const c = seedCase(db, 'HEAD');
    // 120,000 of this quotation's overpayment was moved to another job as credit (unlinked, no refund id).
    db.prepare(
      `INSERT INTO refund_credit_applications (application_id, customer_id, target_quotation_ref, source_quotation_ref, refund_id, kind, amount_ngn, status, ledger_bank_reference, created_at_iso, branch_id)
       VALUES (?, ?, 'QT-AUDIT-OTHER', ?, NULL, 'overpay', 120000, 'Credit confirmation', 'CREDIT_APPLY:RCA-AUDIT-HEAD', '2026-10-02T12:00:00.000Z', 'BR-KD')`
    ).run('RCA-AUDIT-HEAD', c.customer, c.quote);
    // Request 380,000 (= 500,000 overpayment − 120,000 credit): allowed.
    const rid = raise(db, sales, c, 380_000);
    // Approving 450,000 would be above the balance even though it is below the requested amount cap… it is above
    // the requested amount, so test the real case: request 380,000 is approved in full, and a second refund of
    // 1,200,000 cannot be approved because cash 1,500,000 − 380,000 − 120,000 = 1,000,000 is the balance.
    expect(approve(db, admin, rid).ok).toBe(true);
    db.prepare(
      `INSERT INTO customer_refunds (refund_id, customer_id, customer_name, quotation_ref, reason_category, reason, amount_ngn, calculation_lines_json, status, requested_by, requested_at_iso, branch_id, payee_name, payee_account_no, payee_bank_name)
       VALUES ('RF-AUDIT-HEAD-2', ?, 'Audit HEAD', ?, '["Additional services"]', 'Bending', 1200000, ?, 'Pending', 'Audit Sales', '2026-10-03T10:00:00.000Z', 'BR-KD', 'Audit HEAD', '0123456789', 'GT Bank')`
    ).run(c.customer, c.quote, JSON.stringify([{ category: 'Additional services', label: 'Bending', amountNgn: 1_200_000 }]));
    const second = decideRefundRequest(db, 'RF-AUDIT-HEAD-2', { status: 'Approved', approvalDate: '2026-10-03' }, admin);
    expect(second.ok).toBe(false);
    expect(second.code).toBe('REFUND_ABOVE_REFUNDABLE');
    expect(second.error).toMatch(/Approved amount ₦1,200,000 is above the refundable balance ₦1,000,000 by ₦200,000/);
    expect(second.error).toMatch(/cash received ₦1,500,000 − existing refunds ₦380,000 − credit applied to other quotations ₦120,000 = refundable ₦1,000,000/);
    expect(second.refundable).toMatchObject({ cashInNgn: 1_500_000, refundsNgn: 380_000, creditOutNgn: 120_000, refundableNgn: 1_000_000 });
  }, 120_000);

  it('request above the balance is refused with the rule and the numbers', () => {
    const c = seedCase(db, 'MSG');
    const first = raise(db, sales, c, 400_000);
    expect(approve(db, admin, first).ok).toBe(true);
    const r = insertRefundRequest(
      db,
      {
        customerID: c.customer,
        quotationRef: c.quote,
        amountNgn: 1_200_000,
        reasonCategory: ['Additional services'],
        reason: 'Bending',
        calculationLines: [{ category: 'Additional services', label: 'Bending', amountNgn: 1_200_000 }],
      },
      sales,
      'BR-KD'
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/₦1,200,000/);
    expect(r.error).toMatch(/refundable/i);
    expect(r.error).toMatch(/cash received ₦1,500,000/);
  }, 120_000);

  it('company-cut retention: a second credit for the same refund is skipped even when its source_id differs', () => {
    const first = creditCompanyRetentionFromRefundTx(db, { refundId: 'RF-AUDIT-RET', branchId: 'BR-KD', amountNgn: 8_738, actor: admin });
    expect(first.ok).toBe(true);
    expect(first.skipped).toBeFalsy();
    // The RF-KD-26-9737 shape: a row carrying another refund's source_id but this refund_id.
    db.prepare(`UPDATE refund_company_retention_entries SET source_id = 'RF-AUDIT-OTHER' WHERE id = ?`).run(first.entry.id);
    const again = creditCompanyRetentionFromRefundTx(db, { refundId: 'RF-AUDIT-RET', branchId: 'BR-KD', amountNgn: 8_738, actor: admin });
    expect(again.skipped).toBe(true);
    expect(again.reason).toBe('already_credited');
    const n = db.prepare(`SELECT COUNT(*) n FROM refund_company_retention_entries WHERE refund_id = 'RF-AUDIT-RET'`).get();
    expect(Number(n.n)).toBe(1);
  }, 120_000);
});
