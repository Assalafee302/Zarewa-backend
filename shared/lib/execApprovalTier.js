/**
 * Classify executive work-tray items: MD-only vs approvals others can also handle.
 * Used on Command Centre so the MD can prioritise items only they can clear.
 * Frontend copies via `npm run sync:shared` → src/shared/lib/execApprovalTier.js
 */

import { REFUND_MD_APPROVAL_THRESHOLD_NGN } from '../workspaceGovernance.js';

export const EXEC_APPROVAL_TIER_MD_ONLY = 'md_only';
export const EXEC_APPROVAL_TIER_SHARED = 'shared';

/** Tailwind chip classes for Command Centre / exec tray. */
export function approvalTierChipClass(tier) {
  if (tier === EXEC_APPROVAL_TIER_MD_ONLY) {
    return 'bg-violet-100 text-violet-950 ring-violet-200';
  }
  return 'bg-sky-50 text-sky-900 ring-sky-200';
}

const MD_ONLY_KINDS = new Set([
  'price_exception',
  'payroll',
  'inter_branch_loan',
  'stock_register',
  'staff_purchase_credit',
]);

const DEFAULT_EXPENSE_MD_THRESHOLD_NGN = 200_000;

/**
 * @param {object | null | undefined} item
 * @param {{ refundExecutiveThresholdNgn?: number; expenseExecutiveThresholdNgn?: number }} [limits]
 * @returns {{ tier: 'md_only' | 'shared'; label: string; reason?: string }}
 */
export function classifyExecWorkTrayApprovalTier(item, limits = {}) {
  const kind = String(item?.kind || '').trim().toLowerCase();
  const row = item?.reviewContext?.row || item?.row || {};
  const amt = Math.round(
    Number(item?.amountNgn ?? row.amount_ngn ?? row.amount_requested_ngn ?? 0) || 0
  );
  const refundHi = Number(limits.refundExecutiveThresholdNgn) || REFUND_MD_APPROVAL_THRESHOLD_NGN;
  const expenseHi = Number(limits.expenseExecutiveThresholdNgn) || DEFAULT_EXPENSE_MD_THRESHOLD_NGN;

  if (MD_ONLY_KINDS.has(kind)) {
    return { tier: EXEC_APPROVAL_TIER_MD_ONLY, label: 'MD only' };
  }

  if (kind === 'refunds') {
    if (amt >= refundHi) {
      return {
        tier: EXEC_APPROVAL_TIER_MD_ONLY,
        label: 'MD only',
        reason: 'Above refund threshold',
      };
    }
    return { tier: EXEC_APPROVAL_TIER_SHARED, label: 'BM or MD' };
  }

  if (kind === 'register_settlement') {
    if (amt >= refundHi) {
      return {
        tier: EXEC_APPROVAL_TIER_MD_ONLY,
        label: 'MD only',
        reason: 'Above withdrawal threshold',
      };
    }
    return { tier: EXEC_APPROVAL_TIER_SHARED, label: 'Finance / MD' };
  }

  if (kind === 'payments') {
    if (amt >= expenseHi) {
      return {
        tier: EXEC_APPROVAL_TIER_MD_ONLY,
        label: 'MD only',
        reason: 'Large payment',
      };
    }
    return { tier: EXEC_APPROVAL_TIER_SHARED, label: 'Finance / BM' };
  }

  if (kind === 'production') {
    const paid = Math.round(Number(row.paid_ngn ?? row.paidNgn) || 0);
    if (paid <= 0) {
      return {
        tier: EXEC_APPROVAL_TIER_MD_ONLY,
        label: 'MD only',
        reason: 'Zero payment',
      };
    }
    return { tier: EXEC_APPROVAL_TIER_SHARED, label: 'BM or MD' };
  }

  if (kind === 'governance') {
    if (row.refundId || row.kind === 'same_requester_approver' || row.kind === 'approver_is_payer') {
      return { tier: EXEC_APPROVAL_TIER_MD_ONLY, label: 'MD oversight' };
    }
    const paidPct = Number(row.paidPct);
    if (Number.isFinite(paidPct) && paidPct <= 0) {
      return { tier: EXEC_APPROVAL_TIER_MD_ONLY, label: 'MD only', reason: 'Zero payment' };
    }
    return { tier: EXEC_APPROVAL_TIER_MD_ONLY, label: 'MD oversight' };
  }

  if (kind === 'clearance' || kind === 'flagged') {
    return { tier: EXEC_APPROVAL_TIER_SHARED, label: 'Branch Manager' };
  }

  if (kind === 'conversions') {
    return { tier: EXEC_APPROVAL_TIER_SHARED, label: 'BM or MD' };
  }

  if (kind === 'overtime' || kind === 'ot_request') {
    return { tier: EXEC_APPROVAL_TIER_SHARED, label: 'BM or MD' };
  }

  if (kind === 'material') {
    return { tier: EXEC_APPROVAL_TIER_SHARED, label: 'Operations / BM' };
  }

  if (kind === 'edit_approvals') {
    return { tier: EXEC_APPROVAL_TIER_SHARED, label: 'Designated approver' };
  }

  if (kind === 'office_memo' || kind === 'work_item') {
    if (amt >= expenseHi) {
      return { tier: EXEC_APPROVAL_TIER_MD_ONLY, label: 'MD only', reason: 'Large amount' };
    }
    return { tier: EXEC_APPROVAL_TIER_SHARED, label: 'Executive queue' };
  }

  if (item?.summaryOnly) {
    return { tier: EXEC_APPROVAL_TIER_SHARED, label: 'Summary' };
  }

  return { tier: EXEC_APPROVAL_TIER_SHARED, label: 'Review' };
}

/**
 * @param {object[]} items
 * @param {{ refundExecutiveThresholdNgn?: number; expenseExecutiveThresholdNgn?: number }} [limits]
 */
export function annotateExecWorkTrayApprovalTiers(items, limits = {}) {
  return (items || []).map((item) => {
    const { tier, label, reason } = classifyExecWorkTrayApprovalTier(item, limits);
    return {
      ...item,
      approvalTier: tier,
      approvalTierLabel: label,
      approvalTierReason: reason || null,
    };
  });
}

/**
 * @param {object[]} items
 */
export function summarizeExecWorkTrayApprovalTiers(items) {
  let mdOnly = 0;
  let shared = 0;
  for (const it of items || []) {
    if (it?.summaryOnly) continue;
    if (it?.approvalTier === EXEC_APPROVAL_TIER_MD_ONLY) mdOnly += 1;
    else shared += 1;
  }
  return { mdOnly, shared, total: mdOnly + shared };
}

/**
 * @param {object[]} items
 */
export function sortExecWorkTrayByApprovalTier(items) {
  const tierRank = { [EXEC_APPROVAL_TIER_MD_ONLY]: 0, [EXEC_APPROVAL_TIER_SHARED]: 1 };
  const priorityRank = { high: 0, medium: 1, low: 2 };
  return [...(items || [])].sort((a, b) => {
    const ta = tierRank[a.approvalTier] ?? 2;
    const tb = tierRank[b.approvalTier] ?? 2;
    if (ta !== tb) return ta - tb;
    return (priorityRank[a.priority] ?? 9) - (priorityRank[b.priority] ?? 9);
  });
}
