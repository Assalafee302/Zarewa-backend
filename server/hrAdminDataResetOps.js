/**
 * Branch-scoped HR operational data reset — keeps logins, master data, and HR settings.
 * @module server/hrAdminDataResetOps
 */

import { hrTableExists } from './hrTableChecks.js';
import {
  USER_HR_SUBJECT_DELETE_SPECS,
  deleteBenefitPaymentsForUsers,
  deleteDisciplineSubgraphForUsers,
  deleteExitPropertyForUsers,
  deleteRequestDetailsForBranch,
  deleteRowsForUsers,
  safeDelete,
} from './hrUserOperationalCleanup.js';

function branchStaffUserIds(db, branchId) {
  if (!hrTableExists(db, 'hr_staff_profiles')) return [];
  return db
    .prepare(`SELECT user_id AS userId FROM hr_staff_profiles WHERE branch_id = ?`)
    .all(String(branchId || '').trim())
    .map((r) => r.userId)
    .filter(Boolean);
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

  deleteRequestDetailsForBranch(db, bid);
  steps += 1;

  deleteBenefitPaymentsForUsers(db, userIds);
  deleteExitPropertyForUsers(db, userIds);
  deleteDisciplineSubgraphForUsers(db, userIds);
  steps += 1;

  for (const { table, column } of USER_HR_SUBJECT_DELETE_SPECS) {
    deleteRowsForUsers(db, table, column, userIds);
  }
  steps += 1;

  safeDelete(db, `DELETE FROM hr_attendance_uploads WHERE branch_id = ?`, [bid]);
  safeDelete(db, `DELETE FROM hr_daily_roll_calls WHERE branch_id = ?`, [bid]);
  safeDelete(db, `DELETE FROM hr_branch_payroll_contributions WHERE branch_id = ?`, [bid]);
  safeDelete(db, `DELETE FROM hr_performance_reviews WHERE branch_id = ?`, [bid]);
  steps += 1;

  safeDelete(db, `DELETE FROM hr_staff_profiles WHERE branch_id = ?`, [bid]);
  steps += 1;

  safeDelete(db, `DELETE FROM hr_audit_events WHERE branch_id = ?`, [bid]);

  return { ok: true, branchId: bid, staffProfilesRemoved: userIds.length, steps };
}
