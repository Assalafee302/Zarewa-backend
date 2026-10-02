import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createDatabase } from '../db.js';
import { patchSalesReceiptFinanceSettlement } from '../writeOps.js';
import { listEligibleRefundCredits } from '../refundCreditApplyOps.js';
import {
  healReceiptOverpayConfirmTx,
  listReceiptsNeedingOverpayConfirmHeal,
} from './receiptOverpayConfirmHeal.js';
import { DEFAULT_BRANCH_ID } from '../branches.js';

/**
 * RF-KD-26-9693: ₦627,300 was confirmed as new bank cash on two later jobs while ₦861,575 stayed
 * fully payable on the customer's overpayment refund — the same money was set to leave twice.
 * Confirm payment must not accept cash silently while refund fund is still queued for payout.
 */
const ACTOR = { id: 'USR-FIN', displayName: 'Finance', roleKey: 'finance_officer' };

/** Same probe the other integration suites use — no local MySQL means skip, not fail. */
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

describe.skipIf(!mysqlOk)('confirm payment refuses cash while a refund is still waiting to be paid', () => {
  let db;
  let accountId = 0;

  beforeAll(() => {
    db = createDatabase(':memory:');
    // Funded: confirming a receipt as refund fund reverses its RECEIPT_IN, which may not overdraw.
    db.prepare(`INSERT INTO treasury_accounts (name, bank_name, balance, type, branch_id) VALUES (?,?,?,?,?)`).run(
      'Taj Bank',
      'Taj Bank',
      10_000_000,
      'bank',
      DEFAULT_BRANCH_ID
    );
    accountId = Number(
      db.prepare(`SELECT id FROM treasury_accounts WHERE name = ? LIMIT 1`).get('Taj Bank').id
    );
  }, 300_000);

  afterAll(() => {
    db?.close();
  });

  /**
   * One customer who overpaid ₦200,000 on an older job, has an approved overpayment refund still
   * waiting on the payout queue, and an unconfirmed ₦60,000 receipt on a newer job.
   * @param {string} tag unique per test so cases do not share mutated rows
   */
  function seedCustomerWithOpenRefund(tag, { refundStatus = 'Approved', refundPaidNgn = 0 } = {}) {
    const cid = `CUS-${tag}`;
    const src = `QT-${tag}-SRC`;
    const dst = `QT-${tag}-NEW`;
    const refundId = `RF-${tag}`;
    const receiptId = `LE-${tag}-NEW`;
    const lines = JSON.stringify([
      { category: 'Overpayment', amountNgn: 200_000, label: `Overpayment on ${src}` },
    ]);

    db.prepare(`INSERT INTO customers (customer_id, name, branch_id) VALUES (?,?,?)`).run(
      cid,
      `Refund Guard ${tag}`,
      DEFAULT_BRANCH_ID
    );
    const insertQuote = db.prepare(
      `INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso, branch_id)
       VALUES (?,?,?,?,?,?,?,'{}',?,?)`
    );
    insertQuote.run(src, cid, `Refund Guard ${tag}`, 100_000, 300_000, 'Paid', 'Finished', '2026-05-01', DEFAULT_BRANCH_ID);
    insertQuote.run(dst, cid, `Refund Guard ${tag}`, 60_000, 0, 'Unpaid', 'Finished', '2026-05-10', DEFAULT_BRANCH_ID);

    const insertLedger = db.prepare(
      `INSERT INTO ledger_entries (id, type, customer_id, customer_name, quotation_ref, amount_ngn, at_iso, branch_id)
       VALUES (?, 'RECEIPT', ?,?,?,?,?,?)`
    );
    insertLedger.run(`LE-${tag}-SRC`, cid, `Refund Guard ${tag}`, src, 300_000, '2026-05-01T12:00:00.000Z', DEFAULT_BRANCH_ID);
    insertLedger.run(receiptId, cid, `Refund Guard ${tag}`, dst, 60_000, '2026-05-10T12:00:00.000Z', DEFAULT_BRANCH_ID);

    db.prepare(
      `INSERT INTO customer_refunds (
         refund_id, customer_id, customer_name, quotation_ref, reason_category, reason,
         amount_ngn, approved_amount_ngn, status, requested_by, requested_at_iso, paid_amount_ngn,
         credit_applied_ngn, branch_id, calculation_lines_json
       ) VALUES (?,?,?,?,'["Overpayment"]','Overpayment',?,?,?,'Sales One','2026-05-05T10:00:00.000Z',?,0,?,?)`
    ).run(
      refundId,
      cid,
      `Refund Guard ${tag}`,
      src,
      200_000,
      200_000,
      refundStatus,
      refundPaidNgn,
      DEFAULT_BRANCH_ID,
      lines
    );

    db.prepare(
      `INSERT INTO sales_receipts (
         id, customer_id, customer_name, quotation_ref, amount_ngn, amount_display, status, date_iso, ledger_entry_id, branch_id
       ) VALUES (?,?,?,?,?,?, 'Pending clearance', '2026-05-10', ?, ?)`
    ).run(receiptId, cid, `Refund Guard ${tag}`, dst, 60_000, '₦60,000', receiptId, DEFAULT_BRANCH_ID);

    db.prepare(
      `INSERT INTO treasury_movements (
         id, type, source_kind, source_id, treasury_account_id, amount_ngn, posted_at_iso, counterparty_kind
       ) VALUES (?, 'RECEIPT_IN', 'LEDGER_RECEIPT', ?, ?, ?, '2026-05-10T12:00:00.000Z', 'CUSTOMER')`
    ).run(`TM-${tag}-NEW`, receiptId, accountId, 60_000);

    return { cid, dst, refundId, receiptId };
  }

  function auditActions(entityId) {
    return db
      .prepare(`SELECT action FROM audit_log WHERE entity_id = ?`)
      .all(entityId)
      .map((r) => String(r.action));
  }

  it('offers the refund as usable fund on the new job', () => {
    const { cid, dst, refundId } = seedCustomerWithOpenRefund('RFGA');
    const listed = listEligibleRefundCredits(db, cid, dst);
    expect(listed.ok).toBe(true);
    expect(listed.sources.some((s) => s.kind === 'refund' && s.refundId === refundId)).toBe(true);
  });

  it('refuses a full-cash confirm and names the refund money at risk', () => {
    const { receiptId, refundId } = seedCustomerWithOpenRefund('RFGB');
    const settle = patchSalesReceiptFinanceSettlement(db, receiptId, { bankReceivedAmountNgn: 60_000 }, ACTOR);
    expect(settle.ok).toBe(false);
    expect(settle.code).toBe('REFUND_FUND_DECISION_REQUIRED');
    expect(settle.refundFundAvailableNgn).toBe(200_000);
    expect(settle.refundFundSources.map((s) => s.refundId)).toContain(refundId);
    expect(settle.error).toMatch(/still waiting to be paid out/i);

    const rec = db.prepare(`SELECT status FROM sales_receipts WHERE id = ?`).get(receiptId);
    expect(String(rec.status)).toBe('Pending clearance');
  });

  it('rejects a throwaway reason', () => {
    const { receiptId } = seedCustomerWithOpenRefund('RFGC');
    const settle = patchSalesReceiptFinanceSettlement(
      db,
      receiptId,
      { bankReceivedAmountNgn: 60_000, refundFundNotUsedReason: 'no' },
      ACTOR
    );
    expect(settle.ok).toBe(false);
    expect(settle.code).toBe('REFUND_FUND_DECISION_REQUIRED');
  });

  it('lets cash through on a written reason and records who overrode it', () => {
    const { receiptId } = seedCustomerWithOpenRefund('RFGD');
    const settle = patchSalesReceiptFinanceSettlement(
      db,
      receiptId,
      {
        bankReceivedAmountNgn: 60_000,
        refundFundNotUsedReason: 'Customer paid fresh cash at the counter; refund goes to his account',
      },
      ACTOR
    );
    expect(settle.ok).toBe(true);

    const rec = db.prepare(`SELECT status FROM sales_receipts WHERE id = ?`).get(receiptId);
    expect(String(rec.status)).toBe('Cleared');
    expect(auditActions(receiptId)).toContain('receipt.refund_fund_not_used');
  });

  it('needs no reason when the fund covers the receipt, and shrinks what the refund still owes', () => {
    const { receiptId, refundId } = seedCustomerWithOpenRefund('RFGE');
    const settle = patchSalesReceiptFinanceSettlement(
      db,
      receiptId,
      {
        bankReceivedAmountNgn: 0,
        paymentLineCorrections: [],
        refundCreditApply: { amountNgn: 60_000, sourceIds: [`refund:${refundId}`] },
      },
      ACTOR
    );
    expect(settle.error ?? settle.ok).toBe(true);
    expect(settle.refundCreditAppliedNgn).toBe(60_000);
    expect(auditActions(receiptId)).not.toContain('receipt.refund_fund_not_used');
    expect(auditActions(receiptId)).toContain('receipt.refund_fund_unwind');

    const net = db
      .prepare(
        `SELECT COALESCE(SUM(amount_ngn), 0) AS s FROM treasury_movements
         WHERE source_kind = 'LEDGER_RECEIPT' AND source_id = ?`
      )
      .get(receiptId);
    expect(Number(net.s)).toBe(0);
    const recMethod = db.prepare(`SELECT method FROM sales_receipts WHERE id = ?`).get(receiptId);
    expect(recMethod.method).toBe('Refund fund');
    const ledMethod = db.prepare(`SELECT payment_method FROM ledger_entries WHERE id = ?`).get(receiptId);
    expect(ledMethod.payment_method).toBe('Refund fund');

    const refund = db
      .prepare(`SELECT credit_applied_ngn FROM customer_refunds WHERE refund_id = ?`)
      .get(refundId);
    expect(Number(refund.credit_applied_ngn)).toBe(60_000);
  });

  it('leaves a customer with no open refund alone', () => {
    const { receiptId } = seedCustomerWithOpenRefund('RFGF', {
      refundStatus: 'Paid',
      refundPaidNgn: 200_000,
    });
    const settle = patchSalesReceiptFinanceSettlement(db, receiptId, { bankReceivedAmountNgn: 60_000 }, ACTOR);
    expect(settle.ok).toBe(true);
    expect(auditActions(receiptId)).not.toContain('receipt.refund_fund_not_used');
  });

  it('repairs a receipt already confirmed as cash while the refund was still waiting', () => {
    const { receiptId, refundId } = seedCustomerWithOpenRefund('RFGH');
    db.prepare(
      `UPDATE sales_receipts SET
         status = 'Cleared',
         bank_received_amount_ngn = 60000,
         finance_reconciliation_saved_at_iso = '2026-05-11T12:00:00.000Z',
         finance_delivery_cleared_at_iso = '2026-05-11T12:00:00.000Z'
       WHERE id = ?`
    ).run(receiptId);

    const need = listReceiptsNeedingOverpayConfirmHeal(db, {
      receiptIds: [receiptId],
      afterIso: '2026-05-05T10:00:00.000Z',
    });
    expect(need.map((c) => c.receiptId)).toContain(receiptId);

    const healed = healReceiptOverpayConfirmTx(db, receiptId, ACTOR);
    expect(healed.ok).toBe(true);
    expect(healed.refundCreditAppliedNgn).toBe(60_000);

    const refund = db
      .prepare(`SELECT credit_applied_ngn FROM customer_refunds WHERE refund_id = ?`)
      .get(refundId);
    expect(Number(refund.credit_applied_ngn)).toBe(60_000);
  });

  it('still applies a second receipt after the first credit left the refund partially paid', () => {
    const { cid, refundId } = seedCustomerWithOpenRefund('RFGI');
    const receipt2 = `LE-RFGI-2`;
    const dst2 = `QT-RFGI-2`;
    db.prepare(
      `INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso, branch_id)
       VALUES (?,?,?,?,?,?,?,'{}',?,?)`
    ).run(dst2, cid, 'Refund Guard RFGI', 40_000, 0, 'Unpaid', 'Finished', '2026-05-12', DEFAULT_BRANCH_ID);
    db.prepare(
      `INSERT INTO ledger_entries (id, type, customer_id, customer_name, quotation_ref, amount_ngn, at_iso, branch_id)
       VALUES (?, 'RECEIPT', ?,?,?,?,?,?)`
    ).run(receipt2, cid, 'Refund Guard RFGI', dst2, 40_000, '2026-05-12T12:00:00.000Z', DEFAULT_BRANCH_ID);
    db.prepare(
      `INSERT INTO sales_receipts (
         id, customer_id, customer_name, quotation_ref, amount_ngn, amount_display, status, date_iso, ledger_entry_id, branch_id
       ) VALUES (?,?,?,?,?,?, 'Pending clearance', '2026-05-12', ?, ?)`
    ).run(receipt2, cid, 'Refund Guard RFGI', dst2, 40_000, '₦40,000', receipt2, DEFAULT_BRANCH_ID);
    db.prepare(
      `INSERT INTO treasury_movements (
         id, type, source_kind, source_id, treasury_account_id, amount_ngn, posted_at_iso, counterparty_kind
       ) VALUES (?, 'RECEIPT_IN', 'LEDGER_RECEIPT', ?, ?, ?, '2026-05-12T12:00:00.000Z', 'CUSTOMER')`
    ).run('TM-RFGI-2', receipt2, accountId, 40_000);

    const first = patchSalesReceiptFinanceSettlement(
      db,
      `LE-RFGI-NEW`,
      {
        bankReceivedAmountNgn: 0,
        refundCreditApply: { amountNgn: 60_000, sourceIds: [`refund:${refundId}`] },
      },
      ACTOR
    );
    expect(first.ok).toBe(true);
    const second = patchSalesReceiptFinanceSettlement(
      db,
      receipt2,
      {
        bankReceivedAmountNgn: 0,
        refundCreditApply: { amountNgn: 40_000, sourceIds: [`refund:${refundId}`] },
      },
      ACTOR
    );
    expect(second.error ?? second.ok).toBe(true);
    expect(second.refundCreditAppliedNgn).toBe(40_000);
    const refund = db
      .prepare(`SELECT credit_applied_ngn, status FROM customer_refunds WHERE refund_id = ?`)
      .get(refundId);
    expect(Number(refund.credit_applied_ngn)).toBe(100_000);
  });
});
