/**
 * Org-wide governance policy (SQLite-backed) with audit trail.
 * Defaults match shared/workspaceGovernance.js constants.
 */
import crypto from 'node:crypto';
import {
  EXPENSE_MD_APPROVAL_THRESHOLD_NGN,
  REFUND_MD_APPROVAL_THRESHOLD_NGN,
} from '../shared/workspaceGovernance.js';

const KEY_EXPENSE = 'approval.expense_executive_threshold_ngn';
const KEY_REFUND = 'approval.refund_executive_threshold_ngn';

function nowIso() {
  return new Date().toISOString();
}

export function orgPolicyTablesReady(db) {
  try {
    return Boolean(
      db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='org_policy_kv'`).get()
    );
  } catch {
    return false;
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @returns {{ expenseExecutiveThresholdNgn: number; refundExecutiveThresholdNgn: number }}
 */
export function getOrgGovernanceLimits(db) {
  const out = {
    expenseExecutiveThresholdNgn: EXPENSE_MD_APPROVAL_THRESHOLD_NGN,
    refundExecutiveThresholdNgn: REFUND_MD_APPROVAL_THRESHOLD_NGN,
  };
  if (!orgPolicyTablesReady(db)) return out;
  const eRow = db.prepare(`SELECT value_json FROM org_policy_kv WHERE policy_key = ?`).get(KEY_EXPENSE);
  const rRow = db.prepare(`SELECT value_json FROM org_policy_kv WHERE policy_key = ?`).get(KEY_REFUND);
  if (eRow?.value_json != null) {
    try {
      const n = Number(JSON.parse(String(eRow.value_json)));
      if (Number.isFinite(n) && n >= 0) out.expenseExecutiveThresholdNgn = Math.round(n);
    } catch {
      /* keep default */
    }
  }
  if (rRow?.value_json != null) {
    try {
      const n = Number(JSON.parse(String(rRow.value_json)));
      if (Number.isFinite(n) && n >= 0) out.refundExecutiveThresholdNgn = Math.round(n);
    } catch {
      /* keep default */
    }
  }
  return out;
}

function newPolicyAuditId() {
  return `OPA-${crypto.randomUUID()}`;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ expenseExecutiveThresholdNgn?: number; refundExecutiveThresholdNgn?: number }} patch
 * @param {{ id?: string; displayName?: string } | null} actor
 */
export function setOrgGovernanceLimits(db, patch, actor) {
  if (!orgPolicyTablesReady(db)) {
    return { ok: false, error: 'Policy tables are not available. Run migrations.' };
  }
  const exp = patch?.expenseExecutiveThresholdNgn;
  const ref = patch?.refundExecutiveThresholdNgn;
  if (exp === undefined && ref === undefined) {
    return { ok: false, error: 'No limit fields to update.' };
  }
  if (exp !== undefined && (!Number.isFinite(Number(exp)) || Number(exp) < 0)) {
    return { ok: false, error: 'Expense threshold must be a non-negative number.' };
  }
  if (ref !== undefined && (!Number.isFinite(Number(ref)) || Number(ref) < 0)) {
    return { ok: false, error: 'Refund threshold must be a non-negative number.' };
  }

  const before = getOrgGovernanceLimits(db);
  const after = { ...before };
  if (exp !== undefined) after.expenseExecutiveThresholdNgn = Math.round(Number(exp));
  if (ref !== undefined) after.refundExecutiveThresholdNgn = Math.round(Number(ref));

  const uid = String(actor?.id || '').trim() || null;
  const dname = String(actor?.displayName || '').trim() || null;
  const t = nowIso();

  db.transaction(() => {
    if (exp !== undefined) {
      const oldV = JSON.stringify(before.expenseExecutiveThresholdNgn);
      const newV = JSON.stringify(after.expenseExecutiveThresholdNgn);
      db.prepare(
        `INSERT INTO org_policy_kv (policy_key, value_json, updated_at_iso, updated_by_user_id, updated_by_display)
         VALUES (?,?,?,?,?)
         ON CONFLICT(policy_key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at_iso = excluded.updated_at_iso,
           updated_by_user_id = excluded.updated_by_user_id,
           updated_by_display = excluded.updated_by_display`
      ).run(KEY_EXPENSE, newV, t, uid, dname);
      db.prepare(
        `INSERT INTO org_policy_audit (id, policy_key, old_value_json, new_value_json, actor_user_id, actor_display, created_at_iso)
         VALUES (?,?,?,?,?,?,?)`
      ).run(newPolicyAuditId(), KEY_EXPENSE, oldV, newV, uid, dname, t);
    }
    if (ref !== undefined) {
      const oldV = JSON.stringify(before.refundExecutiveThresholdNgn);
      const newV = JSON.stringify(after.refundExecutiveThresholdNgn);
      db.prepare(
        `INSERT INTO org_policy_kv (policy_key, value_json, updated_at_iso, updated_by_user_id, updated_by_display)
         VALUES (?,?,?,?,?)
         ON CONFLICT(policy_key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at_iso = excluded.updated_at_iso,
           updated_by_user_id = excluded.updated_by_user_id,
           updated_by_display = excluded.updated_by_display`
      ).run(KEY_REFUND, newV, t, uid, dname);
      db.prepare(
        `INSERT INTO org_policy_audit (id, policy_key, old_value_json, new_value_json, actor_user_id, actor_display, created_at_iso)
         VALUES (?,?,?,?,?,?,?)`
      ).run(newPolicyAuditId(), KEY_REFUND, oldV, newV, uid, dname, t);
    }
  })();

  return { ok: true, limits: after, before };
}
