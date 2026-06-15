/**
 * HR staff record scope — mirrors listHrStaff visibility for single-record access.
 */
import { listHrStaff } from './hrOps.js';

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ viewAll?: boolean; branchId?: string; scopeMode?: string; actorUserId?: string | null }} scope
 * @param {string} subjectUserId
 */
export function isStaffUserIdInHrScope(db, scope, subjectUserId) {
  const uid = String(subjectUserId || '').trim();
  if (!uid) return false;
  if (scope?.actorUserId && uid === String(scope.actorUserId).trim()) return true;
  const roster = listHrStaff(db, scope, { includeInactive: true });
  return roster.some((s) => String(s.userId) === uid);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ viewAll?: boolean; branchId?: string; scopeMode?: string; actorUserId?: string | null }} scope
 * @param {string} subjectUserId
 */
export function assertStaffUserIdInHrScope(db, scope, subjectUserId) {
  if (isStaffUserIdInHrScope(db, scope, subjectUserId)) return { ok: true };
  return {
    ok: false,
    error: 'Staff record is outside your HR scope.',
    code: 'FORBIDDEN',
    status: 403,
  };
}
