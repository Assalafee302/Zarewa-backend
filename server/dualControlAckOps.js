/**
 * Same-person refund warnings (requester = approver, approver = payer): "Acknowledge with note".
 * Owner decision 2026-10-19 — MD/CEO only, note required, audited. An acknowledged warning leaves the
 * attention list but stays on the refund record with who / when / note.
 *
 * Stored as an audit_log row (action DUAL_CONTROL_ACK_ACTION, entity customer_refund/<refundId>,
 * details { kind, note }) — the audit entry is the acknowledgement; no new table.
 */
import { appendAuditLog } from './controlOps.js';

export const DUAL_CONTROL_ACK_ACTION = 'refund.dual_control.acknowledged';
export const DUAL_CONTROL_KINDS = new Set(['same_requester_approver', 'same_approver_payer']);
export const DUAL_CONTROL_ACK_NOTE_MIN_LEN = 10;

/** MD / CEO only (owner decision) — not admin, not finance. */
export function userMayAcknowledgeDualControl(user) {
  const rk = String(user?.roleKey || '').trim().toLowerCase();
  return rk === 'md' || rk === 'ceo';
}

export const dualControlAckKey = (refundId, kind) => `${String(refundId || '').trim()}:${String(kind || '').trim()}`;

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ refundIds?: string[] }} [opts]
 * @returns {Map<string, { refundId: string, kind: string, note: string, acknowledgedBy: string, acknowledgedByUserId: string, acknowledgedAtIso: string, auditId: string }>}
 */
export function listDualControlAcknowledgements(db, opts = {}) {
  const out = new Map();
  let rows = [];
  try {
    const ids = Array.isArray(opts.refundIds) ? opts.refundIds.map((x) => String(x || '').trim()).filter(Boolean) : null;
    if (ids && ids.length === 0) return out;
    const where = ids ? ` AND entity_id IN (${ids.map(() => '?').join(',')})` : '';
    rows = db
      .prepare(
        `SELECT id, occurred_at_iso, actor_user_id, actor_name, entity_id, note, details_json
         FROM audit_log
         WHERE action = ? AND entity_kind = 'customer_refund'${where}
         ORDER BY occurred_at_iso ASC, id ASC`
      )
      .all(DUAL_CONTROL_ACK_ACTION, ...(ids || []));
  } catch {
    return out;
  }
  for (const r of rows) {
    let details = {};
    try {
      details = JSON.parse(String(r.details_json || '{}')) || {};
    } catch {
      details = {};
    }
    const kind = String(details.kind || '').trim();
    if (!DUAL_CONTROL_KINDS.has(kind)) continue;
    out.set(dualControlAckKey(r.entity_id, kind), {
      refundId: String(r.entity_id || ''),
      kind,
      note: String(details.note || r.note || ''),
      acknowledgedBy: String(r.actor_name || ''),
      acknowledgedByUserId: String(r.actor_user_id || ''),
      acknowledgedAtIso: String(r.occurred_at_iso || ''),
      auditId: String(r.id || ''),
    });
  }
  return out;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ refundId: string, kind: string, note: string, user: object }} input
 */
export function acknowledgeDualControlWarning(db, { refundId, kind, note, user }) {
  const rid = String(refundId || '').trim();
  const k = String(kind || '').trim();
  const text = String(note || '').trim();
  if (!userMayAcknowledgeDualControl(user)) {
    return { ok: false, status: 403, error: 'Only the MD or CEO can acknowledge a same-person refund warning.' };
  }
  if (!rid) return { ok: false, status: 400, error: 'refundId is required.' };
  if (!DUAL_CONTROL_KINDS.has(k)) return { ok: false, status: 400, error: 'Unknown warning kind.' };
  if (text.length < DUAL_CONTROL_ACK_NOTE_MIN_LEN) {
    return {
      ok: false,
      status: 400,
      error: `Write a note of at least ${DUAL_CONTROL_ACK_NOTE_MIN_LEN} characters saying why this is accepted.`,
    };
  }
  const refund = db
    .prepare(
      `SELECT refund_id, requested_by_user_id, approved_by_user_id, paid_by_user_id, requested_by, approved_by, paid_by
       FROM customer_refunds WHERE refund_id = ?`
    )
    .get(rid);
  if (!refund) return { ok: false, status: 404, error: `Refund ${rid} not found.` };
  const applies =
    k === 'same_requester_approver'
      ? refund.requested_by_user_id && refund.requested_by_user_id === refund.approved_by_user_id
      : refund.approved_by_user_id && refund.approved_by_user_id === refund.paid_by_user_id;
  if (!applies) return { ok: false, status: 409, error: 'This warning no longer applies to the refund.' };
  if (listDualControlAcknowledgements(db, { refundIds: [rid] }).has(dualControlAckKey(rid, k))) {
    return { ok: false, status: 409, error: 'This warning is already acknowledged.' };
  }
  appendAuditLog(db, {
    actor: user,
    action: DUAL_CONTROL_ACK_ACTION,
    entityKind: 'customer_refund',
    entityId: rid,
    note: text,
    details: {
      kind: k,
      note: text,
      requestedBy: refund.requested_by || '',
      approvedBy: refund.approved_by || '',
      paidBy: refund.paid_by || '',
    },
  });
  const ack = listDualControlAcknowledgements(db, { refundIds: [rid] }).get(dualControlAckKey(rid, k));
  return { ok: true, acknowledgement: ack };
}
