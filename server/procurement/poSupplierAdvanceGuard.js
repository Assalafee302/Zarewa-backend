/**
 * A purchase order that is already paid up to its ordered value takes no further
 * payment unless an MD note is on the payment. The note is the MD's authority
 * to send more cash than the order.
 */
import { orderedValueFromLines } from '../ap2ReceivedBasisOps.js';

export const MIN_PO_MD_NOTE_LEN = 10;

/**
 * @param {{ paidNgn?: number, orderedNgn?: number, mdNote?: string }} position
 * @returns {null | { ok: false, code: string, error: string }}
 */
export function supplierPaymentCapBlock(position = {}) {
  const ordered = Math.round(Number(position.orderedNgn) || 0);
  const paid = Math.round(Number(position.paidNgn) || 0);
  if (ordered <= 0 || paid < ordered) return null;
  const note = String(position.mdNote || '').trim();
  if (note.length >= MIN_PO_MD_NOTE_LEN) return null;
  const value = ordered.toLocaleString('en-NG');
  const already = paid.toLocaleString('en-NG');
  return {
    ok: false,
    code: 'PO_PAID_IN_FULL',
    error: `This purchase order is already paid ₦${already} against its value of ₦${value}. A further payment needs an MD note.`,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} poId
 * @param {string} [mdNote]
 */
export function poSupplierPaymentCapBlock(db, poId, mdNote) {
  const id = String(poId || '').trim();
  if (!id || !db) return null;
  let po;
  let lines;
  try {
    po = db.prepare(`SELECT supplier_paid_ngn FROM purchase_orders WHERE po_id = ?`).get(id);
    lines = db.prepare(`SELECT * FROM purchase_order_lines WHERE po_id = ?`).all(id);
  } catch {
    return null;
  }
  if (!po) return null;
  return supplierPaymentCapBlock({
    paidNgn: po.supplier_paid_ngn,
    orderedNgn: orderedValueFromLines(lines || []),
    mdNote,
  });
}
