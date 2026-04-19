import { hasPermissionInList } from './moduleAccess.js';
import { userCanApproveEditMutationsClient } from './editApprovalUi.js';
import { isManagerInboxWorkItemDocType } from './managerInboxWorkItemTypes.js';

/**
 * Mirrors server `canSeeManagementApprovalQueues` (workItems.js) for client-side inbox filtering.
 */
export function userMaySeeManagementApprovalQueues(roleKey, permissions) {
  if (hasPermissionInList(permissions, '*')) return true;
  const rk = String(roleKey || '').trim().toLowerCase();
  if (rk === 'admin' || rk === 'ceo' || rk === 'md' || rk === 'sales_manager') return true;
  return hasPermissionInList(permissions, 'sales.manage');
}

/** Mirrors legacy management refund queue visibility on the server. */
export function userMaySeeRefundApprovalQueue(permissions) {
  return (
    hasPermissionInList(permissions, 'refunds.approve') ||
    hasPermissionInList(permissions, 'finance.approve')
  );
}

/**
 * True when the work item is explicitly tied to this user as author, assignee, or visibility (e.g. memo To/Cc).
 */
export function workItemIsPersonalForUser(item, userId) {
  const uid = String(userId || '').trim();
  if (!uid) return false;
  if (String(item?.senderUserId || '').trim() === uid) return true;
  if (String(item?.responsibleUserId || '').trim() === uid) return true;
  const vis = item?.visibility;
  if (Array.isArray(vis)) {
    for (const v of vis) {
      if (
        String(v?.visibilityKind || '').trim() === 'user_id' &&
        String(v?.visibilityValue || '').trim() === uid
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Workspace home unified list:
 * - Personal routing (sent / assigned / To / Cc)
 * - Edit approvals for designated approvers
 * - Manager queues (clearance, production gate, flags, conversion review) for roles that see those queues
 * - Pending payment requests for finance.approve
 * - Refund requests for refunds.approve / finance.approve
 */
export function workItemShowsOnWorkspaceUnifiedInbox(item, { userId, roleKey, permissions }) {
  if (workItemIsPersonalForUser(item, userId)) return true;

  const dt = String(item?.documentType || '').trim().toLowerCase();

  if (dt === 'edit_approval' && userCanApproveEditMutationsClient(roleKey, permissions)) {
    return true;
  }

  if (isManagerInboxWorkItemDocType(dt) && userMaySeeManagementApprovalQueues(roleKey, permissions)) {
    return true;
  }

  if (dt === 'payment_request' && hasPermissionInList(permissions, 'finance.approve')) {
    return true;
  }

  if (dt === 'refund_request' && userMaySeeRefundApprovalQueue(permissions)) {
    return true;
  }

  return false;
}
