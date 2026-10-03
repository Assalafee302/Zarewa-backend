/**
 * Turn the company-retention withdrawal freeze on or off.
 * The read path lives on the retention ledger so approval can see it
 * without importing the audit writer.
 */
import { appendAuditLog } from '../controlOps.js';
import { userMaySetRefundPayoutHold } from '../../shared/workspaceGovernance.js';
import {
  RETENTION_WITHDRAWAL_FREEZE_KEY,
  getRetentionWithdrawalFreeze,
} from './refundCompanyRetentionLedger.js';

const DEFAULT_REASON = 'Sept reconciliation – investigations open';

export function setRetentionWithdrawalFreeze(db, payload, actor) {
  if (!userMaySetRefundPayoutHold(actor)) {
    return { ok: false, code: 'FORBIDDEN', error: 'Only a manager can freeze retention withdrawals.' };
  }
  try {
    db.prepare(`SELECT 1 FROM org_policy_kv LIMIT 1`).get();
  } catch {
    return { ok: false, error: 'Policy store is not ready.' };
  }
  const enabled = payload?.enabled === true || payload?.enabled === 1 || payload?.enabled === '1';
  const reason = String(payload?.reason || (enabled ? DEFAULT_REASON : '')).trim();
  if (enabled && !reason) return { ok: false, error: 'A freeze reason is required.' };
  const before = getRetentionWithdrawalFreeze(db);
  const value = JSON.stringify({ enabled, reason });
  const now = new Date().toISOString();
  const who = String(actor?.displayName || actor?.username || actor?.id || '');
  const userId = actor?.id != null ? String(actor.id) : null;
  const existing = db
    .prepare(`SELECT policy_key FROM org_policy_kv WHERE policy_key = ?`)
    .get(RETENTION_WITHDRAWAL_FREEZE_KEY);
  if (existing) {
    db.prepare(
      `UPDATE org_policy_kv
       SET value_json = ?, updated_at_iso = ?, updated_by_user_id = ?, updated_by_display = ?
       WHERE policy_key = ?`
    ).run(value, now, userId, who, RETENTION_WITHDRAWAL_FREEZE_KEY);
  } else {
    db.prepare(
      `INSERT INTO org_policy_kv (policy_key, value_json, updated_at_iso, updated_by_user_id, updated_by_display)
       VALUES (?,?,?,?,?)`
    ).run(RETENTION_WITHDRAWAL_FREEZE_KEY, value, now, userId, who);
  }
  appendAuditLog(db, {
    actor,
    action: enabled ? 'retention.withdrawal_freeze.on' : 'retention.withdrawal_freeze.off',
    entityKind: 'org_policy',
    entityId: RETENTION_WITHDRAWAL_FREEZE_KEY,
    note: reason || 'Retention withdrawal freeze cleared',
    details: { before, enabled, reason },
  });
  return { ok: true, before, after: { enabled, reason } };
}
