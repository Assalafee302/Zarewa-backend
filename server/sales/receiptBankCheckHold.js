/**
 * Hold a receipt that has no matching bank money, without cancelling it
 * and without touching the treasury line. Status contains "Suspended" so
 * the confirm queue drops it and receiptInvestigationClearanceBlock refuses
 * a later confirm. The cash line stays until someone checks customer credit.
 */
import { appendAuditLog } from '../controlOps.js';

export const RECEIPT_BANK_CHECK_HOLD_NOTE =
  'No bank receipt — awaiting check whether paid from customer credit.';

export const RECEIPT_BANK_CHECK_HOLD_STATUS = `Suspended — ${RECEIPT_BANK_CHECK_HOLD_NOTE}`;

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} receiptId
 * @param {object | null} [actor]
 */
export function holdReceiptAwaitingCreditCheck(db, receiptId, actor = null) {
  const id = String(receiptId || '').trim();
  if (!id) return { ok: false, error: 'Receipt id required.' };
  const row = db.prepare(`SELECT id, status, amount_ngn FROM sales_receipts WHERE id = ?`).get(id);
  if (!row) return { ok: false, error: 'Receipt not found.' };
  const status = String(row.status || '').trim();
  if (/reversed/i.test(status)) return { ok: false, error: 'A reversed receipt cannot be held.' };
  if (/^cleared$/i.test(status)) return { ok: false, error: 'A cleared receipt cannot be held this way.' };
  if (status === RECEIPT_BANK_CHECK_HOLD_STATUS) {
    return { ok: true, alreadyHeld: true, status, amountNgn: row.amount_ngn };
  }
  db.prepare(`UPDATE sales_receipts SET status = ? WHERE id = ?`).run(RECEIPT_BANK_CHECK_HOLD_STATUS, id);
  appendAuditLog(db, {
    actor,
    action: 'receipt.bank_check_hold',
    entityKind: 'sales_receipt',
    entityId: id,
    note: RECEIPT_BANK_CHECK_HOLD_NOTE,
    details: { previousStatus: status, amountNgn: row.amount_ngn },
  });
  return { ok: true, status: RECEIPT_BANK_CHECK_HOLD_STATUS, previousStatus: status, amountNgn: row.amount_ngn };
}
