/**
 * Hold on the unpaid haulage remainder of one purchase order.
 * Does not change transport_paid_ngn or post a treasury movement.
 */
import { hasColumn } from '../ap2ReceivedBasisOps.js';
import { appendAuditLog } from '../controlOps.js';
import { userMaySetRefundPayoutHold } from '../../shared/workspaceGovernance.js';

const NOTE = 'Sept 2026 bank reconciliation – investigation';

export function ensurePoTransportPayoutHoldColumns(db) {
  const add = [
    ['transport_payout_hold', 'INTEGER NOT NULL DEFAULT 0'],
    ['transport_payout_hold_reason', 'TEXT'],
  ];
  for (const [name, ddl] of add) {
    if (hasColumn(db, 'purchase_orders', name)) continue;
    db.exec(`ALTER TABLE purchase_orders ADD COLUMN ${name} ${ddl}`);
  }
}

export function poTransportPayoutHoldBlock(row) {
  const held = row?.transport_payout_hold === 1 || row?.transport_payout_hold === '1' || row?.transportPayoutHold === true;
  if (!held) return null;
  const reason = String(row.transport_payout_hold_reason || row.transportPayoutHoldReason || '').trim();
  return {
    ok: false,
    code: 'TRANSPORT_PAYOUT_HOLD',
    error: reason ? `Haulage on hold: ${reason}` : 'Haulage on hold',
  };
}

export function setPoTransportPayoutHold(db, poId, payload, actor) {
  if (!userMaySetRefundPayoutHold(actor)) {
    return { ok: false, code: 'FORBIDDEN', error: 'Only a manager can set or clear a haulage payout hold.' };
  }
  const id = String(poId || '').trim();
  if (!id) return { ok: false, error: 'PO id is required.' };
  ensurePoTransportPayoutHoldColumns(db);
  const before = db
    .prepare(
      `SELECT po_id, transport_amount_ngn, transport_paid_ngn, transport_payout_hold, transport_payout_hold_reason
       FROM purchase_orders WHERE po_id = ?`
    )
    .get(id);
  if (!before) return { ok: false, error: 'PO not found.' };
  const hold = payload?.hold === true || payload?.hold === 1 || payload?.hold === '1';
  const reason = String(payload?.reason || '').trim();
  if (hold && !reason) return { ok: false, error: 'A hold reason is required.' };
  db.transaction(() => {
    db.prepare(
      `UPDATE purchase_orders SET transport_payout_hold = ?, transport_payout_hold_reason = ? WHERE po_id = ?`
    ).run(hold ? 1 : 0, hold ? reason : String(before.transport_payout_hold_reason || ''), id);
    appendAuditLog(db, {
      actor,
      action: hold ? 'po.transport_payout_hold.set' : 'po.transport_payout_hold.clear',
      entityKind: 'purchase_order',
      entityId: id,
      note: hold ? `${reason} ${NOTE}` : NOTE,
      details: {
        previousHold: Number(before.transport_payout_hold) === 1,
        hold,
        reason,
        transportAmountNgn: Number(before.transport_amount_ngn) || 0,
        transportPaidNgn: Number(before.transport_paid_ngn) || 0,
      },
    });
  })();
  const after = db
    .prepare(`SELECT transport_payout_hold, transport_payout_hold_reason, transport_paid_ngn FROM purchase_orders WHERE po_id = ?`)
    .get(id);
  return {
    ok: true,
    poId: id,
    before: {
      hold: Number(before.transport_payout_hold) === 1,
      reason: String(before.transport_payout_hold_reason || ''),
      transportPaidNgn: Number(before.transport_paid_ngn) || 0,
    },
    after: {
      hold: Number(after.transport_payout_hold) === 1,
      reason: String(after.transport_payout_hold_reason || ''),
      transportPaidNgn: Number(after.transport_paid_ngn) || 0,
    },
  };
}
