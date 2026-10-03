/**
 * Manager payout hold on one customer refund.
 * While payout_hold is set, payRefundEntry and credit-apply from that refund are refused.
 * Only a manager may set or clear it. Each change writes an audit row.
 */
import { actorName } from '../auth.js';
import { hasColumn } from '../ap2ReceivedBasisOps.js';
import { appendAuditLog } from '../controlOps.js';
import { userMaySetRefundPayoutHold } from '../../shared/workspaceGovernance.js';

export function refundRowOnPayoutHold(row) {
  const v = row?.payout_hold ?? row?.payoutHold;
  return v === true || v === 1 || v === '1';
}

export function refundPayoutHoldError(reason) {
  const text = String(reason || '').trim();
  return text ? `Refund on hold: ${text}` : 'Refund on hold';
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} refundId
 * @returns {{ ok: false, code: string, error: string } | null}
 */
export function refundPayoutHoldBlock(db, refundId) {
  const id = String(refundId || '').trim();
  if (!id || !hasColumn(db, 'customer_refunds', 'payout_hold')) return null;
  const row = db
    .prepare(`SELECT payout_hold, payout_hold_reason FROM customer_refunds WHERE refund_id = ?`)
    .get(id);
  if (!row || !refundRowOnPayoutHold(row)) return null;
  return {
    ok: false,
    code: 'REFUND_PAYOUT_HOLD',
    error: refundPayoutHoldError(row.payout_hold_reason),
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} refundId
 * @param {{ hold?: boolean, reason?: string }} payload
 * @param {object | null} actor
 */
export function setRefundPayoutHold(db, refundId, payload, actor) {
  if (!userMaySetRefundPayoutHold(actor)) {
    return {
      ok: false,
      code: 'FORBIDDEN',
      error: 'Only a manager can set or clear a refund payout hold.',
    };
  }
  const id = String(refundId || '').trim();
  if (!id) return { ok: false, error: 'Refund id is required.' };
  if (!hasColumn(db, 'customer_refunds', 'payout_hold')) {
    return { ok: false, error: 'Refund payout hold is not migrated yet. Run migrations.' };
  }
  const row = db.prepare(`SELECT * FROM customer_refunds WHERE refund_id = ?`).get(id);
  if (!row) return { ok: false, error: 'Refund not found.' };

  const hold = payload?.hold === true || payload?.hold === 1 || payload?.hold === '1';
  const reason = String(payload?.reason ?? payload?.note ?? '').trim();
  const now = new Date().toISOString();
  const who = actorName(actor) || 'Manager';

  if (hold) {
    if (!reason) return { ok: false, error: 'A hold reason is required.' };
    if (payload?.reasonOnly && refundRowOnPayoutHold(row)) {
      db.prepare(`UPDATE customer_refunds SET payout_hold_reason = ? WHERE refund_id = ?`).run(reason, id);
      appendAuditLog(db, {
        actor,
        action: 'refund.payout_hold.reason',
        entityKind: 'refund',
        entityId: id,
        note: 'Sept 2026 bank reconciliation – investigation',
        details: { refundId: id, previousReason: String(row.payout_hold_reason || '').trim(), reason },
      });
      return { ok: true, refundId: id, payoutHold: true, payoutHoldReason: reason };
    }
    db.prepare(
      `UPDATE customer_refunds
       SET payout_hold = 1,
           payout_hold_reason = ?,
           hold_set_by = ?,
           hold_set_at = ?,
           hold_cleared_by = NULL,
           hold_cleared_at = NULL
       WHERE refund_id = ?`
    ).run(reason, who, now, id);
    appendAuditLog(db, {
      actor,
      action: 'refund.payout_hold.set',
      entityKind: 'refund',
      entityId: id,
      note: refundPayoutHoldError(reason),
      details: { refundId: id, reason },
    });
    return { ok: true, refundId: id, payoutHold: true, payoutHoldReason: reason };
  }

  if (!refundRowOnPayoutHold(row)) {
    return { ok: false, error: 'Refund is not on hold.' };
  }
  db.prepare(
    `UPDATE customer_refunds
     SET payout_hold = 0,
         hold_cleared_by = ?,
         hold_cleared_at = ?
     WHERE refund_id = ?`
  ).run(who, now, id);
  appendAuditLog(db, {
    actor,
    action: 'refund.payout_hold.clear',
    entityKind: 'refund',
    entityId: id,
    note: `Payout hold cleared. Previous reason: ${String(row.payout_hold_reason || '').trim() || '—'}`,
    details: { refundId: id, previousReason: String(row.payout_hold_reason || '').trim() },
  });
  return { ok: true, refundId: id, payoutHold: false };
}
