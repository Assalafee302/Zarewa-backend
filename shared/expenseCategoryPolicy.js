/**
 * Expense category selection policy — role gates, Others rules, UI filtering.
 * Server enforces; client uses the same helpers for consistent UX.
 */
import { isAllowedExpenseCategory } from './expenseCategories.js';
import {
  getExpenseCategoryLane,
  groupExpenseCategoriesByLane,
  isExceptionExpenseCategory,
  isRevenueExpenseCategory,
  requiresElevatedApprovalLane,
  RESTRICTED_EXPENSE_LANE_KEYS,
} from './expenseCategoryLanes.js';
import { glAccountForExpenseCategory } from './lib/expenseCategoryGlMap.js';
import { isExecutiveRoleKey } from './workspaceGovernance.js';

export const OTHERS_MIN_JUSTIFICATION_LEN = 40;
export const OTHERS_FINANCE_REVIEW_THRESHOLD_NGN = 50_000;
export const AP3_UNCLASSIFIED_ALERT_THRESHOLD_NGN = 100_000;
export const OTHERS_BRANCH_COACH_THRESHOLD_PCT = 15;

/**
 * @param {{
 *   othersMinJustificationLen?: number;
 *   othersFinanceReviewThresholdNgn?: number;
 *   ap3UnclassifiedAlertThresholdNgn?: number;
 *   othersBranchCoachThresholdPct?: number;
 * } | null | undefined} orgLimits
 */
export function resolveExpenseCategoryPolicyLimits(orgLimits) {
  const othersMinJustificationLen = Number(orgLimits?.othersMinJustificationLen);
  const othersFinanceReviewThresholdNgn = Number(orgLimits?.othersFinanceReviewThresholdNgn);
  const ap3UnclassifiedAlertThresholdNgn = Number(orgLimits?.ap3UnclassifiedAlertThresholdNgn);
  const othersBranchCoachThresholdPct = Number(orgLimits?.othersBranchCoachThresholdPct);
  return {
    othersMinJustificationLen:
      Number.isFinite(othersMinJustificationLen) && othersMinJustificationLen >= 10
        ? Math.round(othersMinJustificationLen)
        : OTHERS_MIN_JUSTIFICATION_LEN,
    othersFinanceReviewThresholdNgn:
      Number.isFinite(othersFinanceReviewThresholdNgn) && othersFinanceReviewThresholdNgn >= 0
        ? Math.round(othersFinanceReviewThresholdNgn)
        : OTHERS_FINANCE_REVIEW_THRESHOLD_NGN,
    ap3UnclassifiedAlertThresholdNgn:
      Number.isFinite(ap3UnclassifiedAlertThresholdNgn) && ap3UnclassifiedAlertThresholdNgn >= 0
        ? Math.round(ap3UnclassifiedAlertThresholdNgn)
        : AP3_UNCLASSIFIED_ALERT_THRESHOLD_NGN,
    othersBranchCoachThresholdPct:
      Number.isFinite(othersBranchCoachThresholdPct) &&
      othersBranchCoachThresholdPct >= 1 &&
      othersBranchCoachThresholdPct <= 100
        ? Math.round(othersBranchCoachThresholdPct)
        : OTHERS_BRANCH_COACH_THRESHOLD_PCT,
  };
}

const FINANCE_DESK_ROLES = new Set(['finance_manager', 'cashier', 'accountant']);
const HR_LOAN_ROLES = new Set(['hr_admin', 'gmhr', 'hr_manager']);

/**
 * @param {{ roleKey?: string; permissions?: string[] } | null | undefined} actor
 * @param {(perm: string) => boolean} [hasPermission]
 */
function actorHasWildcard(actor, hasPermission) {
  if (typeof hasPermission === 'function' && hasPermission('*')) return true;
  const perms = Array.isArray(actor?.permissions) ? actor.permissions : [];
  return perms.includes('*');
}

/**
 * @param {{ roleKey?: string; permissions?: string[] } | null | undefined} actor
 * @param {(perm: string) => boolean} [hasPermission]
 */
export function actorMaySelectRestrictedExpenseCategories(actor, hasPermission = () => false) {
  if (!actor) return false;
  if (actorHasWildcard(actor, hasPermission)) return true;
  const rk = String(actor.roleKey || actor.role_key || '').trim().toLowerCase();
  if (rk === 'admin' || isExecutiveRoleKey(rk)) return true;
  if (FINANCE_DESK_ROLES.has(rk)) {
    return hasPermission('finance.post') || hasPermission('finance.approve') || hasPermission('finance.pay');
  }
  return false;
}

/**
 * @param {{ roleKey?: string; permissions?: string[] } | null | undefined} actor
 * @param {string} category
 * @param {(perm: string) => boolean} [hasPermission]
 */
export function actorMaySelectExpenseCategory(actor, category, hasPermission = () => false) {
  const cat = String(category || '').trim();
  if (!isAllowedExpenseCategory(cat)) return false;
  if (isRevenueExpenseCategory(cat)) return false;

  const lane = getExpenseCategoryLane(cat);
  if (!RESTRICTED_EXPENSE_LANE_KEYS.includes(lane)) return true;
  if (lane === 'special' && cat === 'Staff loan') {
    if (actorMaySelectRestrictedExpenseCategories(actor, hasPermission)) return true;
    const rk = String(actor?.roleKey || actor?.role_key || '').trim().toLowerCase();
    return HR_LOAN_ROLES.has(rk);
  }
  return actorMaySelectRestrictedExpenseCategories(actor, hasPermission);
}

/**
 * Categories visible in expense / payment-request forms for this actor.
 * @param {{ roleKey?: string; permissions?: string[] } | null | undefined} actor
 * @param {(perm: string) => boolean} [hasPermission]
 */
export function expenseCategoriesForActor(actor, hasPermission = () => false) {
  return groupExpenseCategoriesByLane()
    .filter((group) => {
      if (group.laneKey === 'revenue') return false;
      if (!RESTRICTED_EXPENSE_LANE_KEYS.includes(group.laneKey)) return true;
      return actorMaySelectRestrictedExpenseCategories(actor, hasPermission);
    })
    .map((group) => ({
      ...group,
      categories: group.categories.filter((cat) => actorMaySelectExpenseCategory(actor, cat, hasPermission)),
    }))
    .filter((group) => group.categories.length > 0);
}

/**
 * @param {string} category
 * @param {number} [amountNgn]
 */
export function requiresFinanceReviewForCategory(category, amountNgn = 0, policyLimits) {
  const limits = resolveExpenseCategoryPolicyLimits(policyLimits);
  if (isExceptionExpenseCategory(category)) return true;
  if (requiresElevatedApprovalLane(category)) return true;
  const amt = Number(amountNgn) || 0;
  if (isExceptionExpenseCategory(category) && amt > limits.othersFinanceReviewThresholdNgn) return true;
  return false;
}

/**
 * Validate category selection for create/update.
 * @param {{
 *   actor?: { roleKey?: string; permissions?: string[] } | null;
 *   category?: string;
 *   amountNgn?: number;
 *   description?: string;
 *   categoryJustification?: string;
 *   hasAttachment?: boolean;
 *   hasPermission?: (perm: string) => boolean;
 *   allowRevenue?: boolean;
 *   policyLimits?: { othersMinJustificationLen?: number; othersFinanceReviewThresholdNgn?: number };
 * }} input
 * @returns {{ ok: true; lane: string } | { ok: false; error: string }}
 */
export function validateExpenseCategorySelection(input = {}) {
  const hasPermission = typeof input.hasPermission === 'function' ? input.hasPermission : () => false;
  const category = String(input.category ?? '').trim();
  const amountNgn = Number(input.amountNgn) || 0;

  if (!category) return { ok: false, error: 'Expense category is required.' };
  if (!isAllowedExpenseCategory(category)) {
    return { ok: false, error: 'Expense category must be chosen from the standard list.' };
  }
  if (isRevenueExpenseCategory(category) && !input.allowRevenue) {
    return {
      ok: false,
      error: 'Revenue categories cannot be used on payment requests. Use the Refund module or Finance posting.',
    };
  }
  if (!actorMaySelectExpenseCategory(input.actor, category, hasPermission)) {
    return {
      ok: false,
      error: 'You cannot select this expense category. Ask Finance or your manager.',
    };
  }

  if (isExceptionExpenseCategory(category)) {
    const limits = resolveExpenseCategoryPolicyLimits(input.policyLimits);
    const justification = String(input.categoryJustification ?? input.description ?? '').trim();
    if (justification.length < limits.othersMinJustificationLen) {
      return {
        ok: false,
        error: `Other expenses need a clear explanation (at least ${limits.othersMinJustificationLen} characters).`,
      };
    }
    if (input.requireAttachment !== false && !input.hasAttachment) {
      return {
        ok: false,
        error: 'Other expenses require an invoice or receipt attachment.',
      };
    }
  }

  const lane = getExpenseCategoryLane(category);
  return {
    ok: true,
    lane,
    requiresFinanceReview: requiresFinanceReviewForCategory(category, amountNgn, input.policyLimits),
  };
}

/**
 * Final gate before treasury payout — blocks revenue categories and mis-routed GL types.
 * @param {string} category
 */
export function validateExpenseCategoryForTreasuryPayout(category) {
  const cat = String(category || '').trim() || 'Others';
  if (isRevenueExpenseCategory(cat)) {
    return {
      ok: false,
      error:
        'Revenue categories cannot be paid through treasury expense payout. Use Refunds or Finance correction.',
    };
  }
  const gl = glAccountForExpenseCategory(cat, { capexAsAsset: true });
  if (gl.accountCode === '4000' || gl.accountCode === '2500') {
    return {
      ok: false,
      error: `Category "${cat}" maps to revenue/liability GL ${gl.accountCode} — cannot post as expense payout.`,
    };
  }
  return {
    ok: true,
    category: cat,
    glAccountCode: gl.accountCode,
    isEquity: gl.isEquity,
    isCapex: gl.isCapex,
  };
}

export const CAPEX_MIN_ASSET_DESCRIPTION_LEN = 10;

/**
 * Capex lane gate — asset narrative + supporting document before treasury payout.
 * @param {{ assetDescription?: string; hasAttachment?: boolean }} input
 */
export function validateCapexTreasuryPayout(input = {}) {
  const assetDescription = String(input.assetDescription ?? '').trim();
  if (assetDescription.length < CAPEX_MIN_ASSET_DESCRIPTION_LEN) {
    return {
      ok: false,
      error: `Capex payout requires a clear asset description (at least ${CAPEX_MIN_ASSET_DESCRIPTION_LEN} characters).`,
    };
  }
  if (!input.hasAttachment) {
    return {
      ok: false,
      error: 'Capex payout requires an invoice, receipt, or procurement attachment.',
    };
  }
  return { ok: true };
}

/**
 * Combined treasury payout gate — revenue/GL block + capex + staff-loan lane rules.
 * @param {{
 *   category?: string;
 *   assetDescription?: string;
 *   hasAttachment?: boolean;
 *   hasHrLoanLink?: boolean;
 * }} input
 */
export function validateSpecialLaneTreasuryPayout(input = {}) {
  const category = String(input.category || '').trim() || 'Others';
  const base = validateExpenseCategoryForTreasuryPayout(category);
  if (!base.ok) return base;

  const lane = getExpenseCategoryLane(category);
  if (lane === 'capex') {
    const capex = validateCapexTreasuryPayout(input);
    if (!capex.ok) return capex;
  }
  if (category === 'Staff loan' && !input.hasHrLoanLink) {
    return {
      ok: false,
      error: 'Staff loan payout must be linked to an approved HR loan request.',
    };
  }
  return base;
}

/**
 * @param {{ roleKey?: string; permissions?: string[] } | null | undefined} actor
 * @param {string} category
 * @param {(perm: string) => boolean} hasPermission
 */
export function actorMayApprovePaymentRequestCategory(actor, category, hasPermission) {
  if (!requiresElevatedApprovalLane(category) && !isExceptionExpenseCategory(category)) return true;
  if (actorHasWildcard(actor, hasPermission)) return true;
  const rk = String(actor?.roleKey || actor?.role_key || '').trim().toLowerCase();
  if (rk === 'admin' || isExecutiveRoleKey(rk)) return true;
  if (!hasPermission('finance.approve')) return false;
  return FINANCE_DESK_ROLES.has(rk);
}

/**
 * Metadata bundle for bootstrap / GET /api/expense-categories.
 * @param {{ roleKey?: string; permissions?: string[] } | null | undefined} actor
 * @param {(perm: string) => boolean} [hasPermission]
 */
export function buildExpenseCategoryMetaForActor(actor, hasPermission = () => false, orgLimits = null) {
  const policyLimits = resolveExpenseCategoryPolicyLimits(orgLimits);
  return {
    groups: expenseCategoriesForActor(actor, hasPermission),
    othersMinJustificationLen: policyLimits.othersMinJustificationLen,
    othersFinanceReviewThresholdNgn: policyLimits.othersFinanceReviewThresholdNgn,
    ap3UnclassifiedAlertThresholdNgn: policyLimits.ap3UnclassifiedAlertThresholdNgn,
    othersBranchCoachThresholdPct: policyLimits.othersBranchCoachThresholdPct,
  };
}

/**
 * Payment requests that need Finance attention (Others, special, capex lanes).
 * @param {string} category
 * @param {string} [laneKey]
 */
export function isFinanceExceptionExpenseItem(category, laneKey) {
  const lane = laneKey || getExpenseCategoryLane(category);
  if (lane === 'exception' || lane === 'special' || lane === 'capex') return true;
  return requiresElevatedApprovalLane(category);
}
