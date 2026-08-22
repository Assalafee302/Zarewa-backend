/**
 * Who may open Chairman Office and request drawings / loans.
 * Kept separate so loan ops do not import the office snapshot module.
 */
import { userHasPermission } from '../auth.js';

export const CHAIRMAN_OFFICE_ROLE_KEYS = new Set(['chairman', 'md', 'admin']);

/**
 * @param {object | null | undefined} user
 */
export function userMayAccessChairmanOffice(user) {
  if (!user) return false;
  if (userHasPermission(user, '*')) return true;
  const rk = String(user.roleKey || '').trim().toLowerCase();
  if (!CHAIRMAN_OFFICE_ROLE_KEYS.has(rk)) return false;
  return (
    userHasPermission(user, 'exec.dashboard.view') ||
    userHasPermission(user, 'hr.chairman.manage')
  );
}

/**
 * @param {object | null | undefined} user
 */
export function userMayRequestChairmanWithdrawal(user) {
  return userMayAccessChairmanOffice(user);
}
