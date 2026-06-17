/**
 * Branch-scoped HR operational data reset — keeps logins, master data, and HR settings.
 * @module server/hrAdminDataResetOps
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

function safeDelete(db, sql, params = []) {
  try {
    db.prepare(sql).run(...params);
    return true;
  } catch (e) {
    if (isIgnorableMissingTableError(e)) return false;
    throw e;
  }
}

function branchStaffUserIds(db, branchId) {
  if (!hrTableExists(db, 'hr_staff_profiles')) return [];
  return db
    .prepare(`SELECT user_id AS userId FROM hr_staff_profiles WHERE branch_id = ?`)
    .all(String(branchId || '').trim())
    .map((r) => r.userId)
    .filter(Boolean);
}

function deleteForUserIds(db, table, column, userIds) {
  if (!userIds.length || !hrTableExists(db, table)) return;
  const chunkSize = 200;
  for (let i = 0; i < userIds.length; i += chunkSize) {
    const chunk = userIds.slice(i, i + chunkSize);
    const placeholders = chunk.map(() => '?').join(',');
    safeDelete(db, `DELETE FROM \`${table}\` WHERE \`${column}\` IN (${placeholders})`, chunk);
  }
}

/**
 * Clears HR transactional data for one branch. Does not remove app_users, hr_settings,
 * hr_designations, hr_departments, hr_salary_matrix, hr_policy_config, or import audit logs.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} branchId
 */
export function resetHrBranchOperationalData(db, branchId) {
  const bid = String(branchId || '').trim();
  if (!bid) return { ok: false, error: 'Branch id is required.' };
  const userIds = branchStaffUserIds(db, bid);
  let steps = 0;

  const runUserScoped = (table, column = 'user_id') => {
    deleteForUserIds(db, table, column, userIds);
    steps += 1;
  };

  // Request detail tables before hr_requests
  runUserScoped('hr_request_leave');
  runUserScoped('hr_request_loan');
  runUserScoped('hr_request_discipline');
  safeDelete(db, `DELETE FROM hr_requests WHERE branch_id = ?`, [bid]);
  steps += 1;

  runUserScoped('hr_payroll_line_loans');
  runUserScoped('hr_payroll_line_recoveries');
  if (hrTableExists(db, 'hr_payroll_lines') && userIds.length) {
    const placeholders = userIds.map(() => '?').join(',');
    safeDelete(db, `DELETE FROM hr_payroll_lines WHERE user_id IN (${placeholders})`, userIds);
  }
  steps += 1;

  runUserScoped('hr_leave_balances');
  runUserScoped('hr_leave_accrual_ledger');
  runUserScoped('hr_attendance_events');
  runUserScoped('hr_salary_history');
  runUserScoped('hr_staff_documents');
  runUserScoped('hr_staff_branch_history');
  runUserScoped('hr_staff_skills');
  runUserScoped('hr_beneficiaries');
  runUserScoped('hr_benefit_payments');
  runUserScoped('hr_incident_memos');
  runUserScoped('hr_transfer_recommendations');
  runUserScoped('hr_transfer_requests');
  runUserScoped('hr_absence_reports');
  runUserScoped('hr_grievances');
  runUserScoped('hr_exit_interviews');
  runUserScoped('hr_exit_clearance');
  runUserScoped('hr_exit_property_items');
  runUserScoped('hr_training_records');
  runUserScoped('hr_policy_acknowledgements');
  runUserScoped('hr_employment_letters');
  runUserScoped('hr_feedback_notes', 'subject_user_id');
  runUserScoped('hr_appraisal_forms', 'subject_user_id');
  runUserScoped('hr_performance_reviews', 'subject_user_id');
  runUserScoped('hr_performance_recognitions', 'subject_user_id');
  runUserScoped('hr_notifications', 'recipient_user_id');
  runUserScoped('hr_employee_number_history');
  runUserScoped('hr_sensitive_tokens');

  // Discipline subgraph
  if (hrTableExists(db, 'hr_discipline_cases') && userIds.length) {
    const caseIds = db
      .prepare(`SELECT id FROM hr_discipline_cases WHERE user_id IN (${userIds.map(() => '?').join(',')})`)
      .all(...userIds)
      .map((r) => r.id);
    if (caseIds.length) {
      const cp = caseIds.map(() => '?').join(',');
      for (const t of [
        'hr_discipline_appeals',
        'hr_discipline_case_witnesses',
        'hr_discipline_case_evidence',
        'hr_discipline_events',
      ]) {
        safeDelete(db, `DELETE FROM \`${t}\` WHERE case_id IN (${cp})`, caseIds);
      }
      safeDelete(db, `DELETE FROM hr_discipline_cases WHERE id IN (${cp})`, caseIds);
    }
  }
  steps += 1;

  safeDelete(db, `DELETE FROM hr_attendance_uploads WHERE branch_id = ?`, [bid]);
  safeDelete(db, `DELETE FROM hr_daily_roll_calls WHERE branch_id = ?`, [bid]);
  safeDelete(db, `DELETE FROM hr_branch_payroll_contributions WHERE branch_id = ?`, [bid]);
  safeDelete(db, `DELETE FROM hr_bonus_requests WHERE branch_id = ?`, [bid]);
  safeDelete(db, `DELETE FROM hr_payroll_reconciliations WHERE branch_id = ?`, [bid]);
  safeDelete(db, `DELETE FROM hr_performance_reviews WHERE branch_id = ?`, [bid]);
  steps += 1;

  runUserScoped('hr_domestic_staff_profiles');
  safeDelete(db, `DELETE FROM hr_staff_profiles WHERE branch_id = ?`, [bid]);
  steps += 1;

  // Branch-scoped audit only — company-wide hr_audit_events are kept
  safeDelete(db, `DELETE FROM hr_audit_events WHERE branch_id = ?`, [bid]);

  return { ok: true, branchId: bid, staffProfilesRemoved: userIds.length, steps };
}
