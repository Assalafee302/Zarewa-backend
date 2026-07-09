/**
 * Annex D configuration control: control-critical env flags are part of the
 * internal control system, so their effective values are written to the audit
 * log at boot whenever they change. This makes silently disabling a preventive
 * control (e.g. the delivery payment gate) visible in the audit trail.
 */
import { appendAuditLog } from './controlOps.js';
import { readDeliveryPaymentGateMode } from './deliveryReleaseGate.js';

const SYSTEM_ACTOR = { id: null, displayName: 'system (boot)', username: 'system' };

function envFlagOn(name) {
  const raw = String(process.env[name] || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

export function readControlFlagSnapshot() {
  return {
    deliveryPaymentGate: readDeliveryPaymentGateMode(),
    deliveryPaymentGateStrictFinance: envFlagOn('DELIVERY_PAYMENT_GATE_STRICT_FINANCE'),
    enforceDualControlPayments: envFlagOn('ENFORCE_DUAL_CONTROL_PAYMENTS'),
    nodeEnv: String(process.env.NODE_ENV || 'development'),
  };
}

/**
 * Compare the current control-flag snapshot with the last audited one and
 * append a `config.control_flags` audit row if it changed (or none exists).
 * Best-effort: never throws — a logging failure must not block boot.
 * @param {import('better-sqlite3').Database} db
 */
export function auditControlFlagsOnBoot(db) {
  try {
    const snapshot = readControlFlagSnapshot();
    const prev = db
      .prepare(`SELECT details_json FROM audit_log WHERE action = 'config.control_flags' ORDER BY rowid DESC LIMIT 1`)
      .get();
    let prevSnapshot = null;
    try {
      prevSnapshot = prev?.details_json ? JSON.parse(prev.details_json) : null;
    } catch {
      prevSnapshot = null;
    }
    const changed = JSON.stringify(prevSnapshot) !== JSON.stringify(snapshot);
    if (!changed) return { logged: false, snapshot };
    appendAuditLog(db, {
      actor: SYSTEM_ACTOR,
      action: 'config.control_flags',
      entityKind: 'config',
      entityId: 'env',
      note: prevSnapshot
        ? 'Control-critical env flags changed since last boot'
        : 'Control-critical env flags recorded at boot',
      details: snapshot,
    });
    if (snapshot.nodeEnv === 'production') {
      if (snapshot.deliveryPaymentGate === 'off') {
        console.warn('[zarewa] WARNING: DELIVERY_PAYMENT_GATE is OFF in production (Annex D expects warn/enforce).');
      }
      if (!snapshot.enforceDualControlPayments) {
        console.warn('[zarewa] WARNING: ENFORCE_DUAL_CONTROL_PAYMENTS is OFF in production (Annex D expects it on).');
      }
    }
    return { logged: true, snapshot };
  } catch (e) {
    console.error('[zarewa] control flag audit failed (non-fatal):', String(e?.message || e));
    return { logged: false, error: String(e?.message || e) };
  }
}
