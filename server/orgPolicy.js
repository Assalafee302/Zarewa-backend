/**
 * Org-wide governance policy (SQLite-backed) with audit trail.
 * Defaults match shared/workspaceGovernance.js constants.
 */
import crypto from 'node:crypto';
import {
  EXPENSE_MD_APPROVAL_THRESHOLD_NGN,
  REFUND_MD_APPROVAL_THRESHOLD_NGN,
} from '../shared/workspaceGovernance.js';
import {
  OTHERS_FINANCE_REVIEW_THRESHOLD_NGN,
  OTHERS_MIN_JUSTIFICATION_LEN,
  AP3_UNCLASSIFIED_ALERT_THRESHOLD_NGN,
  OTHERS_BRANCH_COACH_THRESHOLD_PCT,
} from '../shared/expenseCategoryPolicy.js';
import {
  REFUND_STAFF_ALLOCATION_DEDUCTION_PCT_DEFAULT,
  normalizeRefundStaffAllocationDeductionRate,
  refundStaffAllocationDeductionPctFromRate,
} from '../shared/lib/refundStaffAllocationDeduction.js';

const KEY_EXPENSE = 'approval.expense_executive_threshold_ngn';
const KEY_REFUND = 'approval.refund_executive_threshold_ngn';
const KEY_OTHERS_MIN_JUST = 'expense.others_min_justification_len';
const KEY_OTHERS_REVIEW = 'expense.others_finance_review_threshold_ngn';
const KEY_AP3_ALERT = 'expense.ap3_unclassified_alert_threshold_ngn';
const KEY_OTHERS_COACH_PCT = 'expense.others_branch_coach_threshold_pct';
const KEY_REFUND_STAFF_CUT_PCT = 'refund.staff_allocation_deduction_pct';

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
 * @returns {{
 *   expenseExecutiveThresholdNgn: number;
 *   refundExecutiveThresholdNgn: number;
 *   othersMinJustificationLen: number;
 *   othersFinanceReviewThresholdNgn: number;
 *   ap3UnclassifiedAlertThresholdNgn: number;
 *   othersBranchCoachThresholdPct: number;
 * }}
 */
export function getOrgGovernanceLimits(db) {
  const out = {
    expenseExecutiveThresholdNgn: EXPENSE_MD_APPROVAL_THRESHOLD_NGN,
    refundExecutiveThresholdNgn: REFUND_MD_APPROVAL_THRESHOLD_NGN,
    othersMinJustificationLen: OTHERS_MIN_JUSTIFICATION_LEN,
    othersFinanceReviewThresholdNgn: OTHERS_FINANCE_REVIEW_THRESHOLD_NGN,
    ap3UnclassifiedAlertThresholdNgn: AP3_UNCLASSIFIED_ALERT_THRESHOLD_NGN,
    othersBranchCoachThresholdPct: OTHERS_BRANCH_COACH_THRESHOLD_PCT,
    refundStaffAllocationDeductionPct: REFUND_STAFF_ALLOCATION_DEDUCTION_PCT_DEFAULT,
  };
  if (!orgPolicyTablesReady(db)) return out;
  const eRow = db.prepare(`SELECT value_json FROM org_policy_kv WHERE policy_key = ?`).get(KEY_EXPENSE);
  const rRow = db.prepare(`SELECT value_json FROM org_policy_kv WHERE policy_key = ?`).get(KEY_REFUND);
  const oMinRow = db.prepare(`SELECT value_json FROM org_policy_kv WHERE policy_key = ?`).get(KEY_OTHERS_MIN_JUST);
  const oRevRow = db.prepare(`SELECT value_json FROM org_policy_kv WHERE policy_key = ?`).get(KEY_OTHERS_REVIEW);
  const ap3Row = db.prepare(`SELECT value_json FROM org_policy_kv WHERE policy_key = ?`).get(KEY_AP3_ALERT);
  const coachRow = db.prepare(`SELECT value_json FROM org_policy_kv WHERE policy_key = ?`).get(KEY_OTHERS_COACH_PCT);
  const staffCutRow = db
    .prepare(`SELECT value_json FROM org_policy_kv WHERE policy_key = ?`)
    .get(KEY_REFUND_STAFF_CUT_PCT);
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
  if (oMinRow?.value_json != null) {
    try {
      const n = Number(JSON.parse(String(oMinRow.value_json)));
      if (Number.isFinite(n) && n >= 10) out.othersMinJustificationLen = Math.round(n);
    } catch {
      /* keep default */
    }
  }
  if (oRevRow?.value_json != null) {
    try {
      const n = Number(JSON.parse(String(oRevRow.value_json)));
      if (Number.isFinite(n) && n >= 0) out.othersFinanceReviewThresholdNgn = Math.round(n);
    } catch {
      /* keep default */
    }
  }
  if (ap3Row?.value_json != null) {
    try {
      const n = Number(JSON.parse(String(ap3Row.value_json)));
      if (Number.isFinite(n) && n >= 0) out.ap3UnclassifiedAlertThresholdNgn = Math.round(n);
    } catch {
      /* keep default */
    }
  }
  if (coachRow?.value_json != null) {
    try {
      const n = Number(JSON.parse(String(coachRow.value_json)));
      if (Number.isFinite(n) && n >= 1 && n <= 100) out.othersBranchCoachThresholdPct = Math.round(n);
    } catch {
      /* keep default */
    }
  }
  if (staffCutRow?.value_json != null) {
    try {
      const n = Number(JSON.parse(String(staffCutRow.value_json)));
      if (Number.isFinite(n) && n >= 0 && n <= 99) {
        out.refundStaffAllocationDeductionPct = refundStaffAllocationDeductionPctFromRate(n);
      }
    } catch {
      /* keep default */
    }
  }
  return out;
}

/** Rate 0–0.99 from org policy for staff refund company cut. */
export function getRefundStaffAllocationDeductionRate(db) {
  const pct = getOrgGovernanceLimits(db).refundStaffAllocationDeductionPct;
  return normalizeRefundStaffAllocationDeductionRate(pct);
}

function newPolicyAuditId() {
  return `OPA-${crypto.randomUUID()}`;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   expenseExecutiveThresholdNgn?: number;
 *   refundExecutiveThresholdNgn?: number;
 *   othersMinJustificationLen?: number;
 *   othersFinanceReviewThresholdNgn?: number;
 *   ap3UnclassifiedAlertThresholdNgn?: number;
 *   othersBranchCoachThresholdPct?: number;
 * }} patch
 * @param {{ id?: string; displayName?: string } | null} actor
 */
export function setOrgGovernanceLimits(db, patch, actor) {
  if (!orgPolicyTablesReady(db)) {
    return { ok: false, error: 'Policy tables are not available. Run migrations.' };
  }
  const exp = patch?.expenseExecutiveThresholdNgn;
  const ref = patch?.refundExecutiveThresholdNgn;
  const oMin = patch?.othersMinJustificationLen;
  const oRev = patch?.othersFinanceReviewThresholdNgn;
  const ap3 = patch?.ap3UnclassifiedAlertThresholdNgn;
  const coachPct = patch?.othersBranchCoachThresholdPct;
  const staffCutPct = patch?.refundStaffAllocationDeductionPct;
  if (
    exp === undefined &&
    ref === undefined &&
    oMin === undefined &&
    oRev === undefined &&
    ap3 === undefined &&
    coachPct === undefined &&
    staffCutPct === undefined
  ) {
    return { ok: false, error: 'No limit fields to update.' };
  }
  if (exp !== undefined && (!Number.isFinite(Number(exp)) || Number(exp) < 0)) {
    return { ok: false, error: 'Expense threshold must be a non-negative number.' };
  }
  if (ref !== undefined && (!Number.isFinite(Number(ref)) || Number(ref) < 0)) {
    return { ok: false, error: 'Refund threshold must be a non-negative number.' };
  }
  if (oMin !== undefined && (!Number.isFinite(Number(oMin)) || Number(oMin) < 10)) {
    return { ok: false, error: 'Others justification minimum must be at least 10 characters.' };
  }
  if (oRev !== undefined && (!Number.isFinite(Number(oRev)) || Number(oRev) < 0)) {
    return { ok: false, error: 'Others finance review threshold must be non-negative.' };
  }
  if (ap3 !== undefined && (!Number.isFinite(Number(ap3)) || Number(ap3) < 0)) {
    return { ok: false, error: 'AP3 unclassified alert threshold must be non-negative.' };
  }
  if (
    coachPct !== undefined &&
    (!Number.isFinite(Number(coachPct)) || Number(coachPct) < 1 || Number(coachPct) > 100)
  ) {
    return { ok: false, error: 'Others branch coach threshold must be between 1 and 100 percent.' };
  }
  if (
    staffCutPct !== undefined &&
    (!Number.isFinite(Number(staffCutPct)) || Number(staffCutPct) < 0 || Number(staffCutPct) > 99)
  ) {
    return {
      ok: false,
      error: 'Staff refund company cut must be between 0 and 99 percent.',
    };
  }

  const before = getOrgGovernanceLimits(db);
  const after = { ...before };
  if (exp !== undefined) after.expenseExecutiveThresholdNgn = Math.round(Number(exp));
  if (ref !== undefined) after.refundExecutiveThresholdNgn = Math.round(Number(ref));
  if (oMin !== undefined) after.othersMinJustificationLen = Math.round(Number(oMin));
  if (oRev !== undefined) after.othersFinanceReviewThresholdNgn = Math.round(Number(oRev));
  if (ap3 !== undefined) after.ap3UnclassifiedAlertThresholdNgn = Math.round(Number(ap3));
  if (coachPct !== undefined) after.othersBranchCoachThresholdPct = Math.round(Number(coachPct));
  if (staffCutPct !== undefined) {
    after.refundStaffAllocationDeductionPct = refundStaffAllocationDeductionPctFromRate(
      Number(staffCutPct)
    );
  }

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
    if (oMin !== undefined) {
      const oldV = JSON.stringify(before.othersMinJustificationLen);
      const newV = JSON.stringify(after.othersMinJustificationLen);
      db.prepare(
        `INSERT INTO org_policy_kv (policy_key, value_json, updated_at_iso, updated_by_user_id, updated_by_display)
         VALUES (?,?,?,?,?)
         ON CONFLICT(policy_key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at_iso = excluded.updated_at_iso,
           updated_by_user_id = excluded.updated_by_user_id,
           updated_by_display = excluded.updated_by_display`
      ).run(KEY_OTHERS_MIN_JUST, newV, t, uid, dname);
      db.prepare(
        `INSERT INTO org_policy_audit (id, policy_key, old_value_json, new_value_json, actor_user_id, actor_display, created_at_iso)
         VALUES (?,?,?,?,?,?,?)`
      ).run(newPolicyAuditId(), KEY_OTHERS_MIN_JUST, oldV, newV, uid, dname, t);
    }
    if (oRev !== undefined) {
      const oldV = JSON.stringify(before.othersFinanceReviewThresholdNgn);
      const newV = JSON.stringify(after.othersFinanceReviewThresholdNgn);
      db.prepare(
        `INSERT INTO org_policy_kv (policy_key, value_json, updated_at_iso, updated_by_user_id, updated_by_display)
         VALUES (?,?,?,?,?)
         ON CONFLICT(policy_key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at_iso = excluded.updated_at_iso,
           updated_by_user_id = excluded.updated_by_user_id,
           updated_by_display = excluded.updated_by_display`
      ).run(KEY_OTHERS_REVIEW, newV, t, uid, dname);
      db.prepare(
        `INSERT INTO org_policy_audit (id, policy_key, old_value_json, new_value_json, actor_user_id, actor_display, created_at_iso)
         VALUES (?,?,?,?,?,?,?)`
      ).run(newPolicyAuditId(), KEY_OTHERS_REVIEW, oldV, newV, uid, dname, t);
    }
    if (ap3 !== undefined) {
      const oldV = JSON.stringify(before.ap3UnclassifiedAlertThresholdNgn);
      const newV = JSON.stringify(after.ap3UnclassifiedAlertThresholdNgn);
      db.prepare(
        `INSERT INTO org_policy_kv (policy_key, value_json, updated_at_iso, updated_by_user_id, updated_by_display)
         VALUES (?,?,?,?,?)
         ON CONFLICT(policy_key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at_iso = excluded.updated_at_iso,
           updated_by_user_id = excluded.updated_by_user_id,
           updated_by_display = excluded.updated_by_display`
      ).run(KEY_AP3_ALERT, newV, t, uid, dname);
      db.prepare(
        `INSERT INTO org_policy_audit (id, policy_key, old_value_json, new_value_json, actor_user_id, actor_display, created_at_iso)
         VALUES (?,?,?,?,?,?,?)`
      ).run(newPolicyAuditId(), KEY_AP3_ALERT, oldV, newV, uid, dname, t);
    }
    if (coachPct !== undefined) {
      const oldV = JSON.stringify(before.othersBranchCoachThresholdPct);
      const newV = JSON.stringify(after.othersBranchCoachThresholdPct);
      db.prepare(
        `INSERT INTO org_policy_kv (policy_key, value_json, updated_at_iso, updated_by_user_id, updated_by_display)
         VALUES (?,?,?,?,?)
         ON CONFLICT(policy_key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at_iso = excluded.updated_at_iso,
           updated_by_user_id = excluded.updated_by_user_id,
           updated_by_display = excluded.updated_by_display`
      ).run(KEY_OTHERS_COACH_PCT, newV, t, uid, dname);
      db.prepare(
        `INSERT INTO org_policy_audit (id, policy_key, old_value_json, new_value_json, actor_user_id, actor_display, created_at_iso)
         VALUES (?,?,?,?,?,?,?)`
      ).run(newPolicyAuditId(), KEY_OTHERS_COACH_PCT, oldV, newV, uid, dname, t);
    }
    if (staffCutPct !== undefined) {
      const oldV = JSON.stringify(before.refundStaffAllocationDeductionPct);
      const newV = JSON.stringify(after.refundStaffAllocationDeductionPct);
      db.prepare(
        `INSERT INTO org_policy_kv (policy_key, value_json, updated_at_iso, updated_by_user_id, updated_by_display)
         VALUES (?,?,?,?,?)
         ON CONFLICT(policy_key) DO UPDATE SET
           value_json = excluded.value_json,
           updated_at_iso = excluded.updated_at_iso,
           updated_by_user_id = excluded.updated_by_user_id,
           updated_by_display = excluded.updated_by_display`
      ).run(KEY_REFUND_STAFF_CUT_PCT, newV, t, uid, dname);
      db.prepare(
        `INSERT INTO org_policy_audit (id, policy_key, old_value_json, new_value_json, actor_user_id, actor_display, created_at_iso)
         VALUES (?,?,?,?,?,?,?)`
      ).run(newPolicyAuditId(), KEY_REFUND_STAFF_CUT_PCT, oldV, newV, uid, dname, t);
    }
  })();

  return { ok: true, limits: after, before };
}
