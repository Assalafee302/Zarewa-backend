/**
 * HR staff list scoping: org, branch, department head, supervisor team.
 * @module server/hrTeamScope
 */

import { userHasPermission } from './auth.js';
import { hrMasterDataTablesReady, listHrDepartments } from './hrMasterData.js';

/**
 * @param {object} user
 * @param {string} [requestedScope]
 */
export function resolveHrScopeMode(user, requestedScope = '') {
  const req = String(requestedScope || '').trim().toLowerCase();
  if (req === 'team' && userHasPermission(user, 'hr.team.view')) return 'team';
  if (req === 'department' && (userHasPermission(user, 'hr.team.view') || userHasPermission(user, 'hr.staff.manage'))) {
    return 'department';
  }
  if (
    userHasPermission(user, 'hr.staff.manage') ||
    userHasPermission(user, 'hr.directory.view') ||
    userHasPermission(user, 'hr.executive.view') ||
    userHasPermission(user, '*')
  ) {
    return 'org';
  }
  if (userHasPermission(user, 'hr.team.view')) return 'team';
  return 'branch';
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} user
 * @param {'org'|'branch'|'team'|'department'} scopeMode
 */
export function getDepartmentHeadDepartmentIds(db, userId) {
  if (!hrMasterDataTablesReady(db) || !userId) return [];
  return listHrDepartments(db, { viewAll: true }, { includeInactive: false })
    .filter((d) => d.headUserId === userId)
    .map((d) => d.id);
}

/**
 * Build SQL filter clause for staff queries.
 * @returns {{ clause: string; args: unknown[]; scopeMode: string }}
 */
export function buildStaffScopeFilter(db, baseScope, user, scopeMode) {
  const uid = String(user?.id || '').trim();
  if (baseScope.viewAll || scopeMode === 'org') {
    return { clause: '', args: [], scopeMode: 'org' };
  }
  if (scopeMode === 'team' && uid) {
    return {
      clause: ` AND (p.line_manager_user_id = ? OR p.user_id IN (
        SELECT user_id FROM hr_staff_profiles WHERE line_manager_user_id = ?
      ))`,
      args: [uid, uid],
      scopeMode: 'team',
    };
  }
  if (scopeMode === 'department' && uid) {
    const deptIds = getDepartmentHeadDepartmentIds(db, uid);
    if (deptIds.length) {
      const placeholders = deptIds.map(() => '?').join(',');
      return {
        clause: ` AND (p.department_id IN (${placeholders}) OR p.line_manager_user_id = ?)`,
        args: [...deptIds, uid],
        scopeMode: 'department',
      };
    }
  }
  return {
    clause: ` AND p.branch_id = ?`,
    args: [baseScope.branchId],
    scopeMode: 'branch',
  };
}

export function getTeamRosterSummary(db, scope, user, scopeMode) {
  const filter = buildStaffScopeFilter(db, scope, user, scopeMode);
  let sql = `
    SELECT u.id AS userId, u.display_name AS displayName, p.branch_id AS branchId,
           p.department, p.job_title AS jobTitle, p.line_manager_user_id AS lineManagerUserId
    FROM app_users u
    JOIN hr_staff_profiles p ON p.user_id = u.id
    WHERE u.status = 'active' ${filter.clause}
    ORDER BY u.display_name ASC LIMIT 500`;
  const staff = db.prepare(sql).all(...filter.args);
  return { scopeMode: filter.scopeMode, staff, count: staff.length };
}
