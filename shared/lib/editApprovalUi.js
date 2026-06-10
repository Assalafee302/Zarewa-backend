import { hasPermissionInList } from './moduleAccess.js';

/** Mirrors server: only admin and MD may PATCH without a second-party token. */
export function editMutationNeedsSecondApprovalRole(roleKey) {
  const r = String(roleKey || '').toLowerCase();
  return r !== 'admin' && r !== 'md';
}

/** Client mirror of server `quotationHasActiveSalesReceipts`. */
export function quotationHasActiveSalesReceiptsClient(receipts, quotationId) {
  const id = String(quotationId || '').trim();
  if (!id) return false;
  for (const r of receipts || []) {
    const ref = String(r?.quotationRef ?? r?.quotation_ref ?? '').trim();
    if (ref !== id) continue;
    const st = String(r?.status || '').trim().toLowerCase();
    if (st !== 'reversed') return true;
  }
  return false;
}

/**
 * Quotation save: second approval only when role is gated and the quote has receipts on file.
 * @param {string} [roleKey]
 * @param {object[]} [receipts]
 * @param {string} [quotationId]
 */
export function quotationEditNeedsSecondApprovalClient(roleKey, receipts, quotationId) {
  if (!editMutationNeedsSecondApprovalRole(roleKey)) return false;
  return quotationHasActiveSalesReceiptsClient(receipts, quotationId);
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
