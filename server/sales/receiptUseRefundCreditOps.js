/**
 * Finance Phase A (A6): "Use refund credit instead".
 * For a customer we owe (approved refunds / unapplied credit) whose registered receipt has no
 * bank payment behind it: cancel the unconfirmed cash receipt, in the cashier's name and audited,
 * so the cashier can apply the refund credit to the same quotation instead.
 * Confirm itself is unchanged — this is a separate, secondary action.
 */
import { actorName } from '../auth.js';
import { appendAuditLog } from '../controlOps.js';
import { listEligibleRefundCredits } from '../refundCreditApplyOps.js';
import { reverseReceiptEntry } from '../writeOps.js';

function clean(v) {
  return String(v ?? '').trim();
}

/** @returns {string} '' when the receipt may be cancelled for refund credit */
export function useRefundCreditInsteadBlock(receipt, eligibleTotalNgn) {
  if (!receipt) return 'Receipt not found.';
  const status = clean(receipt.status);
  if (/revers/i.test(status)) return 'This receipt is already reversed.';
  if (/^(cleared|confirmed)$/i.test(status) || clean(receipt.finance_reconciliation_saved_at_iso)) {
    return 'This receipt is already confirmed. Use refund credit only on a receipt with no bank payment, before it is confirmed.';
  }
  if (!clean(receipt.quotation_ref)) return 'This receipt has no quotation to apply refund credit to.';
  if (!(Math.round(Number(eligibleTotalNgn) || 0) > 0)) {
    return 'This customer has no approved refund or unapplied credit that can be used on this quotation.';
  }
  return '';
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} receiptId
 * @param {{ note?: string, branchId?: string }} payload
 * @param {object} actor
 */
export function cancelReceiptForRefundCredit(db, receiptId, payload = {}, actor = null) {
  const id = clean(receiptId);
  const receipt = db.prepare(`SELECT * FROM sales_receipts WHERE id = ?`).get(id);
  const customerId = clean(receipt?.customer_id);
  const quotationRef = clean(receipt?.quotation_ref);
  const eligible = receipt
    ? listEligibleRefundCredits(db, customerId, quotationRef, { branchId: payload.branchId })
    : { totalAvailableNgn: 0 };
  const block = useRefundCreditInsteadBlock(receipt, eligible?.totalAvailableNgn);
  if (block) return { ok: false, code: 'USE_REFUND_CREDIT_NOT_ALLOWED', error: block };

  const cashier = actorName(actor) || 'Cashier';
  const extra = clean(payload.note);
  const note = `Cancelled by ${cashier}: no bank payment for this receipt — customer's refund credit used instead on ${quotationRef}.${extra ? ` ${extra}` : ''}`;
  const entryId = clean(receipt.ledger_entry_id) || id;
  const reversed = reverseReceiptEntry(db, entryId, note, actor);
  if (!reversed.ok) return reversed;
  appendAuditLog(db, {
    actor,
    action: 'receipt.cancel_for_refund_credit',
    entityKind: 'sales_receipt',
    entityId: id,
    status: 'flagged',
    note,
    details: {
      ledgerEntryId: entryId,
      reversalEntryId: reversed.entry?.id ?? '',
      customerId,
      quotationRef,
      amountNgn: Math.round(Number(receipt.amount_ngn) || 0),
      eligibleCreditNgn: Math.round(Number(eligible.totalAvailableNgn) || 0),
      cashier,
    },
  });
  return {
    ok: true,
    receiptId: id,
    customerId,
    quotationRef,
    cancelledAmountNgn: Math.round(Number(receipt.amount_ngn) || 0),
    eligibleCreditNgn: Math.round(Number(eligible.totalAvailableNgn) || 0),
  };
}
