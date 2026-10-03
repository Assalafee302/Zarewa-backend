/**
 * Reclassify a refund payee onto one staff-split distribution.
 * Does not change the approved amount or post cash. Paid amount stays whatever
 * the treasury lines already sum to. Status is resolved from those lines.
 */
import { appendAuditLog } from '../controlOps.js';
import { hasColumn } from '../ap2ReceivedBasisOps.js';
import { resolveRefundStatus } from './refundPayoutStatus.js';

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} refundId
 * @param {{
 *   payeeName: string,
 *   payeeBankName?: string,
 *   payeeAccountNo?: string,
 *   splits: object[],
 *   note?: string,
 * }} payload
 * @param {object | null} actor
 */
export function reclassifyRefundPayeeTx(db, refundId, payload, actor = null) {
  const id = String(refundId || '').trim();
  if (!id) return { ok: false, error: 'Refund id is required.' };
  const payeeName = String(payload?.payeeName || '').trim();
  if (!payeeName) return { ok: false, error: 'Payee name is required.' };
  const splits = Array.isArray(payload?.splits) ? payload.splits : [];
  if (!splits.length) return { ok: false, error: 'A staff-split distribution is required.' };
  const row = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(id);
  if (!row) return { ok: false, error: 'Refund not found.' };

  const payeeBankName = String(payload?.payeeBankName || '').trim();
  const payeeAccountNo = String(payload?.payeeAccountNo || '').trim();
  const extra = String(payload?.note || '').trim();
  const prevNote = String(row.payment_note || '').trim();
  const paymentNote = extra && !prevNote.includes(extra) ? (prevNote ? `${prevNote} ${extra}` : extra) : prevNote;
  const splitJson = JSON.stringify(splits);

  if (hasColumn(db, 'customer_refunds', 'payee_account_no')) {
    db.prepare(
      `UPDATE customer_refunds
       SET payee_name = ?, payee_bank_name = ?, payee_account_no = ?,
           split_distributions_json = ?, payment_note = ?
       WHERE refund_id = ?`
    ).run(payeeName, payeeBankName || null, payeeAccountNo || null, splitJson, paymentNote || null, id);
  } else {
    db.prepare(
      `UPDATE customer_refunds
       SET payee_name = ?, payee_bank_name = ?, split_distributions_json = ?, payment_note = ?
       WHERE refund_id = ?`
    ).run(payeeName, payeeBankName || null, splitJson, paymentNote || null, id);
  }

  const next = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(id);
  const status = resolveRefundStatus(db, next);
  if (status && status !== String(next.status || '')) {
    db.prepare(`UPDATE customer_refunds SET status = ? WHERE refund_id = ?`).run(status, id);
  }
  appendAuditLog(db, {
    actor,
    action: 'refund.payee_reclass',
    entityKind: 'refund',
    entityId: id,
    note: 'Sept 2026 bank reconciliation – investigation',
    details: {
      refundId: id,
      previousPayeeName: String(row.payee_name || ''),
      payeeName,
      payeeBankName,
      status,
    },
  });
  return { ok: true, refundId: id, status, payeeName };
}
