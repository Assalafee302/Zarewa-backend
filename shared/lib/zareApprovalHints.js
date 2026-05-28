/**
 * Plain-language approval blocker explanations for Zare UI hints.
 */
import { hasPermissionInList } from './moduleAccess.js';

/**
 * @param {object} ctx
 * @returns {boolean}
 */
export function userCanApproveWorkItem(item, ctx = {}) {
  if (!item?.requiresApproval) return false;
  const permissions = Array.isArray(ctx.permissions) ? ctx.permissions : [];
  if (hasPermissionInList(permissions, '*')) return true;

  const dt = String(item?.documentType || '').trim().toLowerCase();
  const roleKey = String(ctx.roleKey || '').trim().toLowerCase();

  if (dt === 'payment_request') return hasPermissionInList(permissions, 'finance.approve');
  if (dt === 'refund_request') {
    return (
      hasPermissionInList(permissions, 'refunds.approve') ||
      hasPermissionInList(permissions, 'finance.approve')
    );
  }
  if (dt === 'edit_approval') {
    return ['admin', 'ceo', 'md', 'sales_manager', 'finance_manager', 'branch_manager'].includes(roleKey);
  }
  if (
    [
      'manager_clearance',
      'manager_production_gate',
      'manager_flagged_quote',
      'manager_conversion_review',
      'quotation_clearance',
    ].includes(dt)
  ) {
    return ['admin', 'ceo', 'md', 'sales_manager'].includes(roleKey) || hasPermissionInList(permissions, 'sales.manage');
  }
  if (dt === 'purchase_order' || dt === 'procurement_po') {
    return hasPermissionInList(permissions, 'purchase_orders.manage');
  }
  if (dt === 'material_incident') {
    return ['admin', 'ceo', 'md', 'branch_manager', 'operations_manager'].includes(roleKey);
  }

  return ['admin', 'ceo', 'md', 'branch_manager', 'finance_manager', 'sales_manager'].includes(roleKey);
}

/**
 * @param {object} ctx
 * @returns {{ show: boolean; summary: string; reasons: string[]; zareQuery: string }}
 */
export function explainApprovalBlock(ctx = {}) {
  const reasons = [];
  const status = String(ctx.approvalStatus || ctx.status || '').trim().toLowerCase();
  const documentType = String(ctx.documentType || ctx.entityKind || '').trim().toLowerCase();
  const permissions = Array.isArray(ctx.permissions) ? ctx.permissions : [];

  const zareQuery =
    ctx.zareQuery ||
    `Why can't I approve this ${documentType ? documentType.replace(/_/g, ' ') : 'item'}? Reference: ${ctx.referenceNo || 'unknown'}.`;

  if (ctx.alreadyApproved || /\b(approved|paid|settled|closed|complete)\b/.test(status)) {
    return {
      show: true,
      summary: 'This item has already been approved or completed.',
      reasons: ['No further approval action is required unless you need a correction memo.'],
      zareQuery,
    };
  }

  if (ctx.alreadyRejected || /\breject/.test(status)) {
    return {
      show: true,
      summary: 'This item was rejected.',
      reasons: ['Raise a new request or memo if the business still needs the action.'],
      zareQuery,
    };
  }

  if (ctx.periodLocked) {
    reasons.push('The accounting period for this transaction is locked.');
  }

  if (ctx.missingAttachment) {
    reasons.push('A required attachment or proof document is missing.');
  }

  if (ctx.clearanceBelowAmount && ctx.requiredClearanceLabel) {
    reasons.push(
      `Your clearance may be below the required level for this amount (${ctx.requiredClearanceLabel}).`
    );
  } else if (ctx.clearanceBelowAmount) {
    reasons.push('Your approval clearance may be below the amount on this request.');
  }

  if (ctx.branchMismatch) {
    reasons.push(
      `This item belongs to ${ctx.itemBranchLabel || 'another branch'} — switch branch or ask that branch manager.`
    );
  }

  if (ctx.readOnly || ctx.canMutate === false) {
    reasons.push('Workspace is read-only — reconnect before approving.');
  }

  if (ctx.missingPermission) {
    reasons.push(ctx.missingPermission);
  } else if (ctx.canApprove === false) {
    if (documentType === 'payment_request') {
      reasons.push('Finance approval permission (finance.approve) is required.');
    } else if (documentType === 'refund_request') {
      reasons.push('Refund approval permission (refunds.approve or finance.approve) is required.');
    } else if (documentType === 'purchase_order' || documentType === 'procurement_po') {
      reasons.push('Purchase order management permission (purchase_orders.manage) is required.');
    } else if (documentType === 'edit_approval') {
      reasons.push('A designated manager must approve this edit using the edit-approval workflow.');
    } else {
      reasons.push('Your role does not include approval authority for this item type.');
    }
  }

  if (ctx.requiresEditApproval && !ctx.hasEditApprovalCode) {
    reasons.push('Enter the manager KPI approval code before this PO or edit can be approved.');
  }

  if (!reasons.length && ctx.canApprove !== false) {
    return { show: false, summary: '', reasons: [], zareQuery };
  }

  if (!reasons.length) {
    reasons.push('Approval is blocked — check status, branch, attachments, and clearance rules.');
  }

  return {
    show: true,
    summary: ctx.summary || 'You cannot approve this yet.',
    reasons,
    zareQuery,
  };
}

/**
 * Build context for a normalized workspace work item.
 * @param {object} item
 * @param {object} wsCtx
 */
export function approvalBlockContextForWorkItem(item, wsCtx = {}) {
  const permissions = wsCtx.permissions || [];
  const canApprove = userCanApproveWorkItem(item, wsCtx);
  const itemBranch = String(item?.branchId || '').trim();
  const userBranch = String(wsCtx.branchId || '').trim();
  const branchMismatch =
    Boolean(itemBranch && userBranch && itemBranch !== userBranch && !wsCtx.viewAllBranches);

  return {
    referenceNo: item?.referenceNo,
    documentType: item?.documentType,
    status: item?.status,
    approvalStatus: item?.status,
    requiresApproval: Boolean(item?.requiresApproval),
    canApprove,
    branchMismatch,
    itemBranchLabel: wsCtx.branchNames?.[itemBranch] || itemBranch,
    canMutate: wsCtx.canMutate !== false,
    permissions,
    roleKey: wsCtx.roleKey,
    missingAttachment: Boolean(item?.data?.missingAttachment || item?.missingAttachment),
    periodLocked: Boolean(item?.data?.periodLocked),
    zareQuery: `Why can't I approve ${item?.referenceNo || 'this work item'}? It is a ${String(item?.documentType || 'item').replace(/_/g, ' ')}.`,
  };
}
