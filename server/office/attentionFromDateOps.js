/**
 * ATTENTION_FROM_DATE — branch setting for the finance attention list.
 * Default 2026-08-01 when a branch has no stored date. Reading never writes.
 * Saving (MD, settings.manage) stores the date in org policy; it does not
 * delete, acknowledge, or otherwise change the underlying records.
 */
import crypto from 'node:crypto';
import { orgPolicyTablesReady } from '../orgPolicy.js';
import { listBranches } from '../branches.js';
import { paymentRequestOpenApprovalSql } from '../../shared/lib/paymentRequestStatus.js';
import { SQL_PENDING_BELOW_FLOOR_EXCEPTION } from '../../shared/lib/quotationPriceException.js';
import { readFinanceFeatureFlags } from '../financeFeatureFlags.js';
import {
  ATTENTION_FROM_DATE_DEFAULT,
  ATTENTION_FROM_DATE_SETTING,
  attentionDay,
  countAttentionByType,
} from '../../shared/lib/attentionFromDate.js';

function nowIso() {
  return new Date().toISOString();
}

function tableExists(db, name) {
  try {
    return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name));
  } catch {
    return false;
  }
}

function branchClause(column, branchScope) {
  const bid = String(branchScope || '').trim();
  if (!bid || bid === 'ALL') return { sql: '', args: [] };
  return { sql: ` AND ${column} = ?`, args: [bid] };
}

/** Date is strictly before the start date. Empty dates are not counted. */
function beforeSql(column) {
  const expr = `SUBSTR(COALESCE(${column},''),1,10)`;
  return { expr, sql: `${expr} <> '' AND ${expr} < ?` };
}

/**
 * Stored overrides only. Missing branch → default. `*` is a company-wide override.
 * @param {import('better-sqlite3').Database} db
 * @returns {Record<string, string>}
 */
export function readAttentionFromDateOverrides(db) {
  if (!orgPolicyTablesReady(db)) return {};
  try {
    const row = db.prepare(`SELECT value_json FROM org_policy_kv WHERE policy_key = ?`).get(ATTENTION_FROM_DATE_SETTING);
    if (!row?.value_json) return {};
    const parsed = JSON.parse(String(row.value_json));
    const out = {};
    if (typeof parsed === 'string') {
      const d = attentionDay(parsed);
      if (d) out['*'] = d;
      return out;
    }
    if (!parsed || typeof parsed !== 'object') return {};
    for (const [key, value] of Object.entries(parsed)) {
      const d = attentionDay(value);
      if (d) out[String(key)] = d;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * @param {Record<string, string>} overrides
 * @param {string} branchId
 */
export function effectiveAttentionFromDate(overrides, branchId) {
  const bid = String(branchId || '').trim();
  return attentionDay(overrides?.[bid]) || attentionDay(overrides?.['*']) || ATTENTION_FROM_DATE_DEFAULT;
}

/**
 * Window used by the inbox. Uniform when every branch in scope shares one date,
 * so the list queries can apply a single predicate before their row caps.
 * @param {import('better-sqlite3').Database} db
 * @param {string} [branchScope]
 */
export function resolveAttentionFromDateWindow(db, branchScope = 'ALL') {
  const overrides = readAttentionFromDateOverrides(db);
  const scope = String(branchScope || 'ALL').trim() || 'ALL';
  let branches = [];
  try {
    branches = listBranches(db);
  } catch {
    branches = [];
  }
  const perBranch = {};
  for (const b of branches) {
    perBranch[b.id] = effectiveAttentionFromDate(overrides, b.id);
  }
  if (scope !== 'ALL') {
    const dateISO = perBranch[scope] || effectiveAttentionFromDate(overrides, scope);
    return { dateISO, perBranch: { ...perBranch, [scope]: dateISO }, uniform: true, branchScope: scope };
  }
  const dates = Object.values(perBranch);
  const unique = new Set(dates);
  const uniform = unique.size <= 1;
  const dateISO = uniform ? dates[0] || ATTENTION_FROM_DATE_DEFAULT : ATTENTION_FROM_DATE_DEFAULT;
  return { dateISO, perBranch, uniform, branchScope: scope };
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function listAttentionFromDateSettings(db) {
  const overrides = readAttentionFromDateOverrides(db);
  let branches = [];
  try {
    branches = listBranches(db);
  } catch {
    branches = [];
  }
  return {
    ok: true,
    setting: ATTENTION_FROM_DATE_SETTING,
    defaultDate: ATTENTION_FROM_DATE_DEFAULT,
    branches: branches.map((b) => ({
      branchId: b.id,
      name: b.name || b.code || b.id,
      attentionFromDate: effectiveAttentionFromDate(overrides, b.id),
      stored: Boolean(attentionDay(overrides[b.id]) || (overrides['*'] && !overrides[b.id])),
    })),
  };
}

/**
 * MD / settings.manage. Stores the branch date. Does not touch attention rows.
 * @param {import('better-sqlite3').Database} db
 * @param {string} branchId
 * @param {unknown} dateISO
 * @param {{ id?: string, displayName?: string }} [actor]
 */
export function setBranchAttentionFromDate(db, branchId, dateISO, actor) {
  const bid = String(branchId || '').trim();
  const d = attentionDay(dateISO);
  if (!bid) return { ok: false, error: 'branchId is required.' };
  if (!d) return { ok: false, error: 'ATTENTION_FROM_DATE must be YYYY-MM-DD.' };
  if (!orgPolicyTablesReady(db)) return { ok: false, error: 'Branch settings are not available yet.' };
  const exists = db.prepare(`SELECT 1 FROM branches WHERE id = ?`).get(bid);
  if (!exists) return { ok: false, error: 'Branch not found.' };

  const before = readAttentionFromDateOverrides(db);
  const after = { ...before, [bid]: d };
  const uid = String(actor?.id || '').trim() || null;
  const dname = String(actor?.displayName || '').trim() || null;
  const t = nowIso();
  const oldV = JSON.stringify(before);
  const newV = JSON.stringify(after);
  db.prepare(
    `INSERT INTO org_policy_kv (policy_key, value_json, updated_at_iso, updated_by_user_id, updated_by_display)
     VALUES (?,?,?,?,?)
     ON CONFLICT(policy_key) DO UPDATE SET
       value_json = excluded.value_json,
       updated_at_iso = excluded.updated_at_iso,
       updated_by_user_id = excluded.updated_by_user_id,
       updated_by_display = excluded.updated_by_display`
  ).run(ATTENTION_FROM_DATE_SETTING, newV, t, uid, dname);
  try {
    db.prepare(
      `INSERT INTO org_policy_audit (id, policy_key, old_value_json, new_value_json, actor_user_id, actor_display, created_at_iso)
       VALUES (?,?,?,?,?,?,?)`
    ).run(`OPA-${crypto.randomUUID()}`, ATTENTION_FROM_DATE_SETTING, oldV, newV, uid, dname, t);
  } catch {
    /* audit table is optional for the setting itself */
  }
  return {
    ok: true,
    branchId: bid,
    attentionFromDate: d,
    setting: ATTENTION_FROM_DATE_SETTING,
  };
}

function countOne(db, sql, args) {
  try {
    return Number(db.prepare(sql).get(...args)?.c) || 0;
  } catch {
    return 0;
  }
}

/**
 * Full pending population dated before the window (not the on-screen cap).
 * Same rules as the attention inbox. Read-only.
 * @param {import('better-sqlite3').Database} db
 * @param {string} branchScope
 * @param {{ dateISO: string, perBranch?: Record<string, string>, uniform?: boolean }} window
 */
export function countAttentionBeforeDate(db, branchScope, window) {
  const scope = String(branchScope || 'ALL').trim() || 'ALL';
  if (window?.uniform === false && scope === 'ALL' && window.perBranch && Object.keys(window.perBranch).length) {
    const merged = { orders: 0, cash: 0, floor: 0, control: 0, edits: 0, 'stock review': 0 };
    for (const [bid, date] of Object.entries(window.perBranch)) {
      const part = countAttentionBeforeDate(db, bid, {
        dateISO: attentionDay(date) || ATTENTION_FROM_DATE_DEFAULT,
        uniform: true,
        perBranch: { [bid]: date },
      });
      for (const key of Object.keys(merged)) merged[key] += Number(part.byType?.[key]) || 0;
    }
    const total = Object.values(merged).reduce((sum, n) => sum + n, 0);
    return { total, byType: merged };
  }
  const from = attentionDay(window?.dateISO) || ATTENTION_FROM_DATE_DEFAULT;
  const bQuo = branchClause('branch_id', scope);
  const bCl = branchClause('cl.branch_id', scope);
  const bJob = branchClause('branch_id', scope);
  const bJobJ = branchClause('j.branch_id', scope);
  const bExp = branchClause('e.branch_id', scope);
  const before = beforeSql('date_iso');
  const rows = [];

  const push = (kind, n) => {
    for (let i = 0; i < n; i += 1) rows.push({ kind });
  };

  push(
    'clearance',
    countOne(
      db,
      `SELECT COUNT(*) AS c FROM quotations
       WHERE manager_cleared_at_iso IS NULL AND manager_flagged_at_iso IS NULL AND paid_ngn > 0
         AND ${before.sql}${bQuo.sql}`,
      [from, ...bQuo.args]
    )
  );

  push(
    'flagged',
    countOne(
      db,
      `SELECT COUNT(*) AS c FROM quotations
       WHERE manager_flagged_at_iso IS NOT NULL AND ${before.sql}${bQuo.sql}`,
      [from, ...bQuo.args]
    )
  );

  push(
    'price_exception',
    countOne(
      db,
      `SELECT COUNT(*) AS c FROM quotations
       WHERE ${SQL_PENDING_BELOW_FLOOR_EXCEPTION}
         AND IFNULL(paid_ngn, 0) > 0 AND ${before.sql}${bQuo.sql}`,
      [from, ...bQuo.args]
    )
  );

  const prodBefore = beforeSql('cl.date_iso');
  push(
    'production',
    countOne(
      db,
      `SELECT COUNT(*) AS c FROM cutting_lists cl
       JOIN quotations q ON cl.quotation_ref = q.id
       WHERE cl.status = 'Draft'
         AND q.paid_ngn < (q.total_ngn * 0.7)
         AND q.manager_production_approved_at_iso IS NULL
         AND ${prodBefore.sql}${bCl.sql}`,
      [from, ...bCl.args]
    )
  );

  if (tableExists(db, 'hr_staff_obligation_accounts')) {
    const creditBefore = beforeSql(`COALESCE(created_at_iso, updated_at_iso)`);
    const bCredit = branchClause('branch_id', scope);
    push(
      'staff_purchase_credit',
      countOne(
        db,
        `SELECT COUNT(*) AS c FROM hr_staff_obligation_accounts
         WHERE kind = 'purchase' AND status = 'pending_approval' AND ${creditBefore.sql}${bCredit.sql}`,
        [from, ...bCredit.args]
      )
    );
  }

  const refundBefore = beforeSql('requested_at_iso');
  const bRef = branchClause('branch_id', scope);
  push(
    'refunds',
    countOne(
      db,
      `SELECT COUNT(*) AS c FROM customer_refunds WHERE status = 'Pending' AND ${refundBefore.sql}${bRef.sql}`,
      [from, ...bRef.args]
    )
  );

  const payBefore = beforeSql('pr.request_date');
  push(
    'payments',
    countOne(
      db,
      `SELECT COUNT(*) AS c FROM payment_requests pr
       LEFT JOIN expenses e ON e.expense_id = pr.expense_id
       WHERE ${paymentRequestOpenApprovalSql('pr.approval_status')} AND ${payBefore.sql}${bExp.sql}`,
      [from, ...bExp.args]
    )
  );

  if (tableExists(db, 'accounting_register_settlements')) {
    const setBefore = beforeSql('requested_at_iso');
    const bSet = branchClause('branch_id', scope);
    push(
      'register_settlement',
      countOne(
        db,
        `SELECT COUNT(*) AS c FROM accounting_register_settlements
         WHERE status = 'Pending' AND ${setBefore.sql}${bSet.sql}`,
        [from, ...bSet.args]
      )
    );
  }

  if (tableExists(db, 'ot_requests')) {
    const otBefore = beforeSql(`COALESCE(submitted_at_iso, updated_at_iso, created_at_iso)`);
    const bOt = branchClause('branch_id', scope);
    push(
      'overtime',
      countOne(
        db,
        `SELECT COUNT(*) AS c FROM ot_requests
         WHERE status = 'pending_bm_approval' AND ${otBefore.sql}${bOt.sql}`,
        [from, ...bOt.args]
      )
    );
  }

  const convBefore = beforeSql('completed_at_iso');
  push(
    'conversions',
    countOne(
      db,
      `SELECT COUNT(*) AS c FROM production_jobs
       WHERE status = 'Completed'
         AND (manager_review_signed_at_iso IS NULL OR TRIM(COALESCE(manager_review_signed_at_iso, '')) = '')
         AND (
           manager_review_required = 1
           OR UPPER(TRIM(COALESCE(conversion_alert_state, ''))) IN ('HIGH', 'LOW')
         )
         AND ${convBefore.sql}${bJob.sql}`,
      [from, ...bJob.args]
    )
  );

  if (tableExists(db, 'material_incidents')) {
    const bMat = branchClause('branch_id', scope);
    push(
      'material',
      countOne(
        db,
        `SELECT COUNT(*) AS c FROM material_incidents
         WHERE status = 'submitted' AND ${before.sql}${bMat.sql}`,
        [from, ...bMat.args]
      )
    );
  }

  const gateBefore = beforeSql('j.completed_at_iso');
  push(
    'governance',
    countOne(
      db,
      `SELECT COUNT(*) AS c FROM production_jobs j
       JOIN quotations q ON q.id = j.quotation_ref
       WHERE j.status = 'Completed'
         AND IFNULL(q.total_ngn, 0) > 0
         AND IFNULL(q.paid_ngn, 0) < IFNULL(q.total_ngn, 0) * 0.7
         AND (q.manager_production_approved_at_iso IS NULL OR TRIM(COALESCE(q.manager_production_approved_at_iso, '')) = '')
         AND ${gateBefore.sql}${bJobJ.sql}`,
      [from, ...bJobJ.args]
    )
  );

  if (tableExists(db, 'edit_approval_tokens')) {
    const editBefore = beforeSql('requested_at_iso');
    const bEdit = branchClause('branch_id', scope);
    push(
      'edit_approvals',
      countOne(
        db,
        `SELECT COUNT(*) AS c FROM edit_approval_tokens
         WHERE status = 'pending' AND ${editBefore.sql}${bEdit.sql}`,
        [from, ...bEdit.args]
      )
    );
  }

  if (readFinanceFeatureFlags().enforceDualControlPayments && tableExists(db, 'customer_refunds')) {
    const bDc = branchClause('branch_id', scope);
    const dcBefore = beforeSql(`COALESCE(paid_at_iso, approval_date, requested_at_iso)`);
    push(
      'governance',
      countOne(
        db,
        `SELECT COUNT(*) AS c FROM customer_refunds
         WHERE TRIM(COALESCE(LOWER(status), '')) IN ('approved', 'paid')
           AND (
             (requested_by_user_id IS NOT NULL AND requested_by_user_id = approved_by_user_id)
             OR (approved_by_user_id IS NOT NULL AND approved_by_user_id = paid_by_user_id)
           )
           AND ${dcBefore.sql}${bDc.sql}`,
        [from, ...bDc.args]
      )
    );
  }

  const byType = countAttentionByType(rows);
  const total = Object.values(byType).reduce((s, n) => s + n, 0);
  return { total, byType };
}
