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
import { isExecutiveRoleKey } from './workspaceGovernance.js';

export const OTHERS_MIN_JUSTIFICATION_LEN = 40;
export const OTHERS_FINANCE_REVIEW_THRESHOLD_NGN = 50_000;

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
export function requiresFinanceReviewForCategory(category, amountNgn = 0) {
  if (isExceptionExpenseCategory(category)) return true;
  if (requiresElevatedApprovalLane(category)) return true;
  const amt = Number(amountNgn) || 0;
  if (isExceptionExpenseCategory(category) && amt > OTHERS_FINANCE_REVIEW_THRESHOLD_NGN) return true;
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
    const justification = String(input.categoryJustification ?? input.description ?? '').trim();
    if (justification.length < OTHERS_MIN_JUSTIFICATION_LEN) {
      return {
        ok: false,
        error: `Other expenses need a clear explanation (at least ${OTHERS_MIN_JUSTIFICATION_LEN} characters).`,
      };
    }
    if (!input.hasAttachment) {
      return {
        ok: false,
        error: 'Other expenses require an invoice or receipt attachment.',
      };
    }
  }

  const lane = getExpenseCategoryLane(category);
  return { ok: true, lane, requiresFinanceReview: requiresFinanceReviewForCategory(category, amountNgn) };
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
export function buildExpenseCategoryMetaForActor(actor, hasPermission = () => false) {
  return {
    groups: expenseCategoriesForActor(actor, hasPermission),
    othersMinJustificationLen: OTHERS_MIN_JUSTIFICATION_LEN,
    othersFinanceReviewThresholdNgn: OTHERS_FINANCE_REVIEW_THRESHOLD_NGN,
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
