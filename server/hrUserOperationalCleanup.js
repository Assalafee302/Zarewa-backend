/**
 * Shared HR operational row cleanup — single source of truth for column names and delete order.
 * Used by branch HR reset, staff duplicate purge, and zero-audit login removal.
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
];

/** Nullable FK columns on other rows that reference this user. */
const USER_REFERENCE_NULL_SPECS = [
  { table: 'hr_staff_profiles', column: 'line_manager_user_id' },
  { table: 'hr_grievances', column: 'assigned_to_user_id' },
  { table: 'hr_departments', column: 'head_user_id' },
  { table: 'hr_requests', column: 'hr_reviewer_user_id' },
  { table: 'hr_requests', column: 'manager_reviewer_user_id' },
  { table: 'hr_policy_acknowledgements', column: 'accepted_by_user_id' },
  { table: 'hr_policy_acknowledgements', column: 'witness_user_id' },
  { table: 'accounting_period_locks', column: 'locked_by_user_id' },
  { table: 'approval_actions', column: 'acted_by_user_id' },
  { table: 'workspace_bulk_action_log', column: 'actor_user_id' },
];

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

/**
 * @param {import('better-sqlite3').Database} db
 */
export function nullUserReferences(db, userId) {
  const uid = String(userId || '').trim();
  if (!uid) return;
  for (const { table, column } of USER_REFERENCE_NULL_SPECS) {
    if (!hrTableExists(db, table) || !tableHasColumn(db, table, column)) continue;
    safeDelete(db, `UPDATE \`${table}\` SET \`${column}\` = NULL WHERE \`${column}\` = ?`, [uid]);
  }
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
 */
export function purgeUserHrOperationalData(db, userId) {
  const uid = String(userId || '').trim();
  if (!uid) return;

  nullUserReferences(db, uid);
  deleteRequestDetailsForUser(db, uid);
  deleteBenefitPaymentsForUser(db, uid);
  deleteExitPropertyForUser(db, uid);
  deleteDisciplineSubgraphForUser(db, uid);

  for (const { table, column } of USER_HR_SUBJECT_DELETE_SPECS) {
    deleteRowsForUser(db, table, column, uid);
  }

  deleteRowsForUser(db, 'hr_staff_profiles', 'user_id', uid);
}
