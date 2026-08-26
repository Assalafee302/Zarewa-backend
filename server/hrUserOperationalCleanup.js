/**
 * Shared HR operational row cleanup — single source of truth for column names and delete order.
 * Used by branch HR reset, staff duplicate purge, login merge, and zero-audit login removal.
 * Before DELETE FROM app_users, actor FKs without ON DELETE CASCADE must be reassigned or nulled.
 * @module server/hrUserOperationalCleanup
 */

import { hrTableExists } from './hrTableChecks.js';

function isIgnorableMissingTableError(e) {
  const msg = String(e?.message || e || '');
  const code = String(e?.code || '');
  return (
    code === 'ER_NO_SUCH_TABLE' ||
    msg.includes('1146') ||
    msg.includes('42S02') ||
    msg.includes('no such table')
  );
}

function isIgnorableUnknownColumnError(e) {
  const msg = String(e?.message || e || '');
  const code = String(e?.code || '');
  return (
    code === 'ER_BAD_FIELD_ERROR' ||
    msg.includes('Unknown column') ||
    msg.includes('1054')
  );
}

function isIgnorableNotNullError(e) {
  const msg = String(e?.message || e || '');
  const code = String(e?.code || '');
  const errno = Number(e?.errno);
  return (
    code === 'ER_BAD_NULL_ERROR' ||
    code === 'ER_NO_DEFAULT_FOR_FIELD' ||
    errno === 1048 ||
    errno === 1364 ||
    /cannot be null/i.test(msg) ||
    /SQLITE_CONSTRAINT_NOTNULL/i.test(msg)
  );
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function tableHasColumn(db, table, column) {
  const t = String(table || '').trim();
  const c = String(column || '').trim();
  if (!t || !c) return false;
  try {
    return db.prepare(`PRAGMA table_info(${t})`).all().some((row) => row.name === c);
  } catch {
    return false;
  }
}

/**
 * Direct user-scoped deletes — table + column must match schema (validated before SQL).
 * @type {Array<{ table: string; column: string }>}
 */
export const USER_HR_SUBJECT_DELETE_SPECS = [
  { table: 'hr_payroll_line_loans', column: 'user_id' },
  { table: 'hr_payroll_line_recoveries', column: 'user_id' },
  { table: 'hr_payroll_lines', column: 'user_id' },
  { table: 'hr_leave_balances', column: 'user_id' },
  { table: 'hr_leave_accrual_ledger', column: 'user_id' },
  { table: 'hr_attendance_events', column: 'user_id' },
  { table: 'hr_salary_history', column: 'user_id' },
  { table: 'hr_staff_documents', column: 'user_id' },
  { table: 'hr_staff_branch_history', column: 'user_id' },
  { table: 'hr_staff_skills', column: 'user_id' },
  { table: 'hr_beneficiaries', column: 'user_id' },
  { table: 'hr_incident_memos', column: 'user_id' },
  { table: 'hr_transfer_recommendations', column: 'user_id' },
  { table: 'hr_transfer_requests', column: 'user_id' },
  { table: 'hr_absence_reports', column: 'user_id' },
  { table: 'hr_grievances', column: 'user_id' },
  { table: 'hr_exit_interviews', column: 'user_id' },
  { table: 'hr_exit_clearance', column: 'user_id' },
  { table: 'hr_training_records', column: 'user_id' },
  { table: 'hr_policy_acknowledgements', column: 'user_id' },
  { table: 'hr_employment_letters', column: 'user_id' },
  { table: 'hr_feedback_notes', column: 'subject_user_id' },
  { table: 'hr_appraisal_forms', column: 'subject_user_id' },
  { table: 'hr_performance_reviews', column: 'user_id' },
  { table: 'hr_performance_recognitions', column: 'user_id' },
  { table: 'hr_notifications', column: 'user_id' },
  { table: 'hr_employee_number_history', column: 'user_id' },
  { table: 'hr_sensitive_tokens', column: 'user_id' },
  { table: 'hr_engagement_responses', column: 'user_id' },
  { table: 'hr_domestic_staff_profiles', column: 'user_id' },
  { table: 'office_memo_drafts', column: 'user_id' },
  { table: 'workspace_read_state', column: 'user_id' },
  { table: 'office_thread_reads', column: 'user_id' },
  { table: 'ot_staff_lines', column: 'staff_user_id' },
];

/**
 * Actor/history columns that reference app_users without ON DELETE CASCADE.
 * Merge reassigns these to the kept login; purge sets NULL (or the actor if NOT NULL).
 */
export const USER_REFERENCE_NULL_SPECS = [
  { table: 'hr_staff_profiles', column: 'line_manager_user_id' },
  { table: 'hr_staff_profiles', column: 'updated_by_user_id' },
  { table: 'hr_grievances', column: 'assigned_to_user_id' },
  { table: 'hr_departments', column: 'head_user_id' },
  { table: 'hr_requests', column: 'hr_reviewer_user_id' },
  { table: 'hr_requests', column: 'manager_reviewer_user_id' },
  { table: 'hr_requests', column: 'gm_hr_reviewer_user_id' },
  { table: 'hr_policy_acknowledgements', column: 'accepted_by_user_id' },
  { table: 'hr_policy_acknowledgements', column: 'witness_user_id' },
  { table: 'hr_employment_letters', column: 'issued_by_user_id' },
  { table: 'accounting_period_locks', column: 'locked_by_user_id' },
  { table: 'approval_actions', column: 'acted_by_user_id' },
  { table: 'audit_log', column: 'actor_user_id' },
  { table: 'hr_audit_events', column: 'actor_user_id' },
  { table: 'workspace_bulk_action_log', column: 'actor_user_id' },
  { table: 'office_threads', column: 'created_by_user_id' },
  { table: 'workspace_rooms', column: 'created_by_user_id' },
];

const APP_USER_IDENTITY_COLUMNS = new Set([
  'user_sessions.user_id',
  'hr_staff_profiles.user_id',
  'hr_discipline_cases.user_id',
  ...USER_HR_SUBJECT_DELETE_SPECS.map((s) => `${s.table}.${s.column}`),
]);

function specKey(table, column) {
  return `${String(table || '').trim().toLowerCase()}.${String(column || '').trim().toLowerCase()}`;
}

function isIdentityAppUserColumn(table, column) {
  return APP_USER_IDENTITY_COLUMNS.has(specKey(table, column));
}

/**
 * Production MySQL may have extra FKs that schemaSql does not list.
 * @param {import('better-sqlite3').Database} db
 * @returns {Array<{ table: string; column: string }>}
 */
function listMysqlRestrictAppUserForeignKeys(db) {
  try {
    return db
      .prepare(
        `SELECT kcu.TABLE_NAME AS tableName, kcu.COLUMN_NAME AS columnName
         FROM information_schema.KEY_COLUMN_USAGE kcu
         INNER JOIN information_schema.REFERENTIAL_CONSTRAINTS rc
           ON rc.CONSTRAINT_SCHEMA = kcu.TABLE_SCHEMA
          AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
          AND rc.TABLE_NAME = kcu.TABLE_NAME
         WHERE kcu.TABLE_SCHEMA = DATABASE()
           AND kcu.REFERENCED_TABLE_NAME = 'app_users'
           AND kcu.REFERENCED_COLUMN_NAME = 'id'
           AND UPPER(IFNULL(rc.DELETE_RULE, 'RESTRICT')) NOT IN ('CASCADE', 'SET NULL')`
      )
      .all()
      .map((row) => ({
        table: String(row.tableName ?? row.TABLE_NAME ?? '').trim(),
        column: String(row.columnName ?? row.COLUMN_NAME ?? '').trim(),
      }))
      .filter((s) => s.table && s.column);
  } catch {
    return [];
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @returns {Array<{ table: string; column: string }>}
 */
export function collectAppUserDetachSpecs(db) {
  const seen = new Set();
  const out = [];
  function add(table, column) {
    if (isIdentityAppUserColumn(table, column)) return;
    const key = specKey(table, column);
    if (!key || key === '.' || seen.has(key)) return;
    seen.add(key);
    out.push({ table: String(table).trim(), column: String(column).trim() });
  }
  for (const spec of USER_REFERENCE_NULL_SPECS) add(spec.table, spec.column);
  for (const spec of listMysqlRestrictAppUserForeignKeys(db)) add(spec.table, spec.column);
  return out;
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function safeDelete(db, sql, params = []) {
  try {
    db.prepare(sql).run(...params);
    return true;
  } catch (e) {
    if (isIgnorableMissingTableError(e) || isIgnorableUnknownColumnError(e)) return false;
    throw e;
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function deleteRowsForUser(db, table, column, userId) {
  const uid = String(userId || '').trim();
  if (!uid || !hrTableExists(db, table)) return false;
  if (!tableHasColumn(db, table, column)) return false;
  return safeDelete(db, `DELETE FROM \`${table}\` WHERE \`${column}\` = ?`, [uid]);
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function deleteRowsForUsers(db, table, column, userIds) {
  if (!Array.isArray(userIds) || !userIds.length) return;
  if (!hrTableExists(db, table) || !tableHasColumn(db, table, column)) return;
  const chunkSize = 200;
  for (let i = 0; i < userIds.length; i += chunkSize) {
    const chunk = userIds.slice(i, i + chunkSize).map((id) => String(id).trim()).filter(Boolean);
    if (!chunk.length) continue;
    const placeholders = chunk.map(() => '?').join(',');
    safeDelete(db, `DELETE FROM \`${table}\` WHERE \`${column}\` IN (${placeholders})`, chunk);
  }
}

function updateUserFkColumn(db, table, column, fromUserId, toUserId) {
  try {
    db.prepare(`UPDATE \`${table}\` SET \`${column}\` = ? WHERE \`${column}\` = ?`).run(toUserId, fromUserId);
    return true;
  } catch (e) {
    if (isIgnorableMissingTableError(e) || isIgnorableUnknownColumnError(e)) return false;
    throw e;
  }
}

function nullUserFkColumn(db, table, column, userId) {
  try {
    db.prepare(`UPDATE \`${table}\` SET \`${column}\` = NULL WHERE \`${column}\` = ?`).run(userId);
    return true;
  } catch (e) {
    if (isIgnorableMissingTableError(e) || isIgnorableUnknownColumnError(e) || isIgnorableNotNullError(e)) {
      return false;
    }
    throw e;
  }
}

/**
 * Reassign actor/history FKs from one login to another so the extra app_users row can be deleted.
 * @param {import('better-sqlite3').Database} db
 */
export function reassignUserReferences(db, fromUserId, toUserId) {
  const fromId = String(fromUserId || '').trim();
  const toId = String(toUserId || '').trim();
  if (!fromId || !toId || fromId === toId) return;
  for (const { table, column } of collectAppUserDetachSpecs(db)) {
    updateUserFkColumn(db, table, column, fromId, toId);
  }
}

/**
 * Clear actor/history FKs. NOT NULL columns stay put unless `fallbackActorUserId` is set.
 * @param {import('better-sqlite3').Database} db
 */
export function nullUserReferences(db, userId, { fallbackActorUserId } = {}) {
  const uid = String(userId || '').trim();
  if (!uid) return;
  const fallback = String(fallbackActorUserId || '').trim();
  for (const { table, column } of collectAppUserDetachSpecs(db)) {
    const cleared = nullUserFkColumn(db, table, column, uid);
    if (!cleared && fallback && fallback !== uid) {
      updateUserFkColumn(db, table, column, uid, fallback);
    }
  }
}

/**
 * Detach non-CASCADE app_users FKs before DELETE FROM app_users.
 * Merge must reassign; purge nulls (or reassigns leftover NOT NULL columns to the actor).
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 * @param {{ reassignToUserId?: string; fallbackActorUserId?: string }} [opts]
 */
export function detachAppUserReferences(db, userId, opts = {}) {
  const keep = String(opts.reassignToUserId || '').trim();
  if (keep) {
    reassignUserReferences(db, userId, keep);
    return;
  }
  nullUserReferences(db, userId, { fallbackActorUserId: opts.fallbackActorUserId });
}

/**
 * hr_request_* tables use request_id, not user_id.
 * @param {import('better-sqlite3').Database} db
 */
export function deleteRequestDetailsForUser(db, userId) {
  const uid = String(userId || '').trim();
  if (!uid || !hrTableExists(db, 'hr_requests')) return;
  for (const table of ['hr_request_leave', 'hr_request_loan', 'hr_request_discipline']) {
    if (!hrTableExists(db, table) || !tableHasColumn(db, table, 'request_id')) continue;
    safeDelete(
      db,
      `DELETE FROM \`${table}\` WHERE request_id IN (SELECT id FROM hr_requests WHERE user_id = ?)`,
      [uid]
    );
  }
  deleteRowsForUser(db, 'hr_requests', 'user_id', uid);
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function deleteRequestDetailsForBranch(db, branchId) {
  const bid = String(branchId || '').trim();
  if (!bid || !hrTableExists(db, 'hr_requests')) return;
  for (const table of ['hr_request_leave', 'hr_request_loan', 'hr_request_discipline']) {
    if (!hrTableExists(db, table) || !tableHasColumn(db, table, 'request_id')) continue;
    safeDelete(
      db,
      `DELETE FROM \`${table}\` WHERE request_id IN (SELECT id FROM hr_requests WHERE branch_id = ?)`,
      [bid]
    );
  }
  safeDelete(db, `DELETE FROM hr_requests WHERE branch_id = ?`, [bid]);
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function deleteBenefitPaymentsForUser(db, userId) {
  const uid = String(userId || '').trim();
  if (!uid || !hrTableExists(db, 'hr_benefit_payments') || !hrTableExists(db, 'hr_beneficiaries')) return;
  if (!tableHasColumn(db, 'hr_benefit_payments', 'beneficiary_id')) return;
  if (!tableHasColumn(db, 'hr_beneficiaries', 'user_id')) return;
  safeDelete(
    db,
    `DELETE FROM hr_benefit_payments WHERE beneficiary_id IN (SELECT id FROM hr_beneficiaries WHERE user_id = ?)`,
    [uid]
  );
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function deleteBenefitPaymentsForUsers(db, userIds) {
  if (!Array.isArray(userIds) || !userIds.length) return;
  if (!hrTableExists(db, 'hr_benefit_payments') || !hrTableExists(db, 'hr_beneficiaries')) return;
  if (!tableHasColumn(db, 'hr_benefit_payments', 'beneficiary_id')) return;
  if (!tableHasColumn(db, 'hr_beneficiaries', 'user_id')) return;
  const chunkSize = 200;
  for (let i = 0; i < userIds.length; i += chunkSize) {
    const chunk = userIds.slice(i, i + chunkSize).map((id) => String(id).trim()).filter(Boolean);
    if (!chunk.length) continue;
    const placeholders = chunk.map(() => '?').join(',');
    safeDelete(
      db,
      `DELETE FROM hr_benefit_payments WHERE beneficiary_id IN (SELECT id FROM hr_beneficiaries WHERE user_id IN (${placeholders}))`,
      chunk
    );
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function deleteExitPropertyForUser(db, userId) {
  const uid = String(userId || '').trim();
  if (!uid || !hrTableExists(db, 'hr_exit_property_items') || !hrTableExists(db, 'hr_exit_clearance')) return;
  if (!tableHasColumn(db, 'hr_exit_property_items', 'clearance_id')) return;
  if (!tableHasColumn(db, 'hr_exit_clearance', 'user_id')) return;
  safeDelete(
    db,
    `DELETE FROM hr_exit_property_items WHERE clearance_id IN (SELECT id FROM hr_exit_clearance WHERE user_id = ?)`,
    [uid]
  );
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function deleteExitPropertyForUsers(db, userIds) {
  if (!Array.isArray(userIds) || !userIds.length) return;
  if (!hrTableExists(db, 'hr_exit_property_items') || !hrTableExists(db, 'hr_exit_clearance')) return;
  if (!tableHasColumn(db, 'hr_exit_property_items', 'clearance_id')) return;
  if (!tableHasColumn(db, 'hr_exit_clearance', 'user_id')) return;
  const chunkSize = 200;
  for (let i = 0; i < userIds.length; i += chunkSize) {
    const chunk = userIds.slice(i, i + chunkSize).map((id) => String(id).trim()).filter(Boolean);
    if (!chunk.length) continue;
    const placeholders = chunk.map(() => '?').join(',');
    safeDelete(
      db,
      `DELETE FROM hr_exit_property_items WHERE clearance_id IN (SELECT id FROM hr_exit_clearance WHERE user_id IN (${placeholders}))`,
      chunk
    );
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function deleteDisciplineSubgraphForUser(db, userId) {
  const uid = String(userId || '').trim();
  if (!uid || !hrTableExists(db, 'hr_discipline_cases') || !tableHasColumn(db, 'hr_discipline_cases', 'user_id')) {
    return;
  }
  const caseIds = db
    .prepare(`SELECT id FROM hr_discipline_cases WHERE user_id = ?`)
    .all(uid)
    .map((r) => r.id);
  if (!caseIds.length) return;
  const cp = caseIds.map(() => '?').join(',');
  for (const t of [
    'hr_discipline_appeals',
    'hr_discipline_case_witnesses',
    'hr_discipline_case_evidence',
    'hr_discipline_events',
    'hr_incident_recovery_schedules',
  ]) {
    if (hrTableExists(db, t) && tableHasColumn(db, t, 'case_id')) {
      safeDelete(db, `DELETE FROM \`${t}\` WHERE case_id IN (${cp})`, caseIds);
    }
  }
  safeDelete(db, `DELETE FROM hr_discipline_cases WHERE id IN (${cp})`, caseIds);
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function deleteDisciplineSubgraphForUsers(db, userIds) {
  if (!Array.isArray(userIds) || !userIds.length) return;
  for (const uid of userIds) {
    deleteDisciplineSubgraphForUser(db, uid);
  }
}

/**
 * Remove all HR operational rows for one login (does not delete app_users).
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 * @param {{ fallbackActorUserId?: string }} [opts]
 */
export function purgeUserHrOperationalData(db, userId, opts = {}) {
  const uid = String(userId || '').trim();
  if (!uid) return;

  detachAppUserReferences(db, uid, { fallbackActorUserId: opts.fallbackActorUserId });
  deleteRequestDetailsForUser(db, uid);
  deleteBenefitPaymentsForUser(db, uid);
  deleteExitPropertyForUser(db, uid);
  deleteDisciplineSubgraphForUser(db, uid);

  for (const { table, column } of USER_HR_SUBJECT_DELETE_SPECS) {
    deleteRowsForUser(db, table, column, uid);
  }

  deleteRowsForUser(db, 'hr_staff_profiles', 'user_id', uid);
}
