import { hasPermissionInList } from './moduleAccess.js';

/** Mirrors server: only admin and MD may PATCH without a second-party token. */
export function editMutationNeedsSecondApprovalRole(roleKey) {
  const r = String(roleKey || '').toLowerCase();
  return r !== 'admin' && r !== 'md';
}

const APPROVER_ROLES = new Set([
  'admin',
  'md',
  'sales_manager',
  'finance_manager',
  'operations_officer',
]);

/**
 * Who may approve another user's edit request (align with server/auth.js userCanApproveEditMutations).
 * @param {string} [roleKey]
 * @param {string[]} [permissions] session/bootstrap permission list; quotations.manage also grants approve (server parity).
 */
export function userCanApproveEditMutationsClient(roleKey, permissions) {
  if (APPROVER_ROLES.has(String(roleKey || '').toLowerCase())) return true;
  return hasPermissionInList(permissions, 'quotations.manage');
}
