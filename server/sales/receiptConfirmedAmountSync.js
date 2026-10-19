/**
 * Keep sales_receipts.bank_received_amount_ngn (the finance-confirmed amount) in step with later
 * corrections of a cleared receipt.
 *
 * Refund cash-in, open-credit caps and quotations.paid_ngn read bank_received_amount_ngn as the
 * authoritative amount once a receipt is cleared. A correction that changed the receipt book
 * amount, ledger split and treasury lines but not this field left refunds on the old figure
 * (QT-KD-26-1818 / LE-KD-26-2150: bank lines ₦1,250,000 + ₦464,000, field stayed ₦1,679,000).
 */
import { isReceiptCleared, isReceiptReversed } from '../../shared/lib/receiptClearance.js';

function roundMoney(v) {
  return Math.round(Number(v) || 0);
}

/**
 * New bank_received_amount_ngn after the receipt book amount is aligned to `confirmedNgn`,
 * or null when the field should stay as it is.
 * Only receipts finance has already confirmed carry the field forward — a pending receipt
 * gets its confirmed amount from the confirm step itself.
 * @param {object} row sales_receipts row
 * @param {number} confirmedNgn
 * @returns {number | null}
 */
export function receiptConfirmedBankAmountAfterCorrection(row, confirmedNgn) {
  if (!row || isReceiptReversed(row)) return null;
  const hasConfirmed = row.bank_received_amount_ngn != null || row.bankReceivedAmountNgn != null;
  if (!hasConfirmed && !isReceiptCleared(row)) return null;
  const next = roundMoney(confirmedNgn);
  if (next < 0) return null;
  const current = hasConfirmed ? roundMoney(row.bank_received_amount_ngn ?? row.bankReceivedAmountNgn) : null;
  return current === next ? null : next;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} row sales_receipts row (as read before the correction)
 * @param {number} confirmedNgn
 * @returns {{ changed: boolean, previousNgn: number | null, nextNgn: number | null }}
 */
export function syncReceiptConfirmedBankAmountTx(db, row, confirmedNgn) {
  const next = receiptConfirmedBankAmountAfterCorrection(row, confirmedNgn);
  const previous = row?.bank_received_amount_ngn != null ? roundMoney(row.bank_received_amount_ngn) : null;
  if (next == null) return { changed: false, previousNgn: previous, nextNgn: previous };
  db.prepare(`UPDATE sales_receipts SET bank_received_amount_ngn = ? WHERE id = ?`).run(next, row.id);
  return { changed: true, previousNgn: previous, nextNgn: next };
}
