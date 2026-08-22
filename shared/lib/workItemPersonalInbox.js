/**
 * Workspace unified-inbox visibility (personal routing + role queues).
 * Frontend copies via `npm run sync:shared` → src/shared/lib/workItemPersonalInbox.js
 */
import { hasPermissionInList } from './moduleAccess.js';
import { userCanApproveEditMutationsClient } from './editApprovalUi.js';
import { isManagerInboxWorkItemDocType } from './managerInboxWorkItemTypes.js';
import { userMayReviewPaymentRequests } from '../workspaceGovernance.js';

function userMaySeeStaffPurchaseCreditQueue(roleKey, permissions) {
  const rk = String(roleKey || '').trim().toLowerCase();
  if (hasPermissionInList(permissions, '*')) return true;
  if (rk === 'md') return true;
  if (hasPermissionInList(permissions, 'hr.payroll.md_approve')) return true;
  return (
    hasPermissionInList(permissions, 'hr.loans.manage') || hasPermissionInList(permissions, 'hr.staff.manage')
  );
}

/**
 * Mirrors server `canSeeManagementApprovalQueues` (workItems.js) for client-side inbox filtering.
 * CEO is included so executive inbox filtering matches the SPA.
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

function userMaySeeRegisterSettlement(item, permissions) {
  const st = String(item?.status || '').trim().toLowerCase();
  const awaitingPay = st === 'awaiting_payment' || st === 'approved_awaiting_pay';
  if (awaitingPay) {
    return (
      hasPermissionInList(permissions, 'finance.pay') ||
      hasPermissionInList(permissions, 'cashier.desk.view') ||
      hasPermissionInList(permissions, 'finance.approve') ||
      hasPermissionInList(permissions, '*')
    );
  }
  return (
    hasPermissionInList(permissions, 'refunds.approve') ||
    hasPermissionInList(permissions, 'finance.approve') ||
    hasPermissionInList(permissions, '*')
  );
}

/**
 * Workspace home unified list:
 * - Personal routing (sent / assigned / To / Cc)
 * - Edit approvals for designated approvers
 * - Manager queues (clearance, production gate, flags, conversion review) for roles that see those queues
 * - Payment requests for branch / finance / executive reviewers
 * - Refund requests for refunds.approve / finance.approve
 * - Register settlements for finance approve/pay (and cashier when awaiting payout)
 * - Staff purchase credit for MD / HR loan managers
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

  if (
    dt === 'payment_request' &&
    userMayReviewPaymentRequests({ roleKey, permissions }, (perm) => hasPermissionInList(permissions, perm))
  ) {
    return true;
  }

  if (dt === 'refund_request' && userMaySeeRefundApprovalQueue(permissions)) {
    return true;
  }

  if (dt === 'register_settlement') {
    return userMaySeeRegisterSettlement(item, permissions);
  }

  if (dt === 'staff_purchase_credit' && userMaySeeStaffPurchaseCreditQueue(roleKey, permissions)) {
    return true;
  }

  return false;
}
