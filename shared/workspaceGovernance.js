/**
 * Workspace governance — approval limits and role gates (single source of truth).
 * Aligns with common internal-control practice: documented authorization thresholds
 * and segregation so high-value decisions require executive sign-off.
 *
 * Thresholds may be overridden per org via {@link getOrgGovernanceLimits} on the server;
 * client code uses bootstrap `orgGovernanceLimits` for display only — enforcement is server-side.
 */

/** Refund approvals strictly above this amount require MD/CEO-level (or admin) sign-off. */
export const REFUND_MD_APPROVAL_THRESHOLD_NGN = 1_000_000;

/**
 * Payment request (expense disbursement) amounts strictly above this require
 * MD/CEO-level sign-off for non-refund-like categories, except categories treated as refund-like (see below).
 * Amounts at or below this may be approved by a branch manager (see {@link isBranchExpenseApproverRoleKey}).
 */
export const EXPENSE_MD_APPROVAL_THRESHOLD_NGN = 200_000;

const EXECUTIVE_ROLE_KEYS = new Set(['md', 'ceo', 'chairman']);

/**
 * Roles that may approve routine branch expenses up to the expense executive threshold
 * (maps to "Branch manager" in ROLE_DEFINITIONS as `sales_manager`; `branch_manager` reserved for future).
 * @param {string | null | undefined} roleKey
 * @returns {boolean}
 */
export function isBranchExpenseApproverRoleKey(roleKey) {
  const rk = String(roleKey || '').trim().toLowerCase();
  return rk === 'sales_manager' || rk === 'branch_manager';
}

/**
 * @param {string | null | undefined} roleKey
 * @returns {boolean}
 */
export function isExecutiveRoleKey(roleKey) {
  return EXECUTIVE_ROLE_KEYS.has(String(roleKey || '').trim().toLowerCase());
}

/**
 * Expense / payment-request categories that are excluded from the general-expense MD threshold
 * (refunds are governed separately via refund threshold).
 * @param {string | null | undefined} expenseCategory
 * @returns {boolean}
 */
export function isRefundLikeExpenseCategory(expenseCategory) {
  const c = String(expenseCategory || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
  if (!c) return false;
  return c.includes('refund') || c === 'customer_refund' || c === 'refund_payout';
}

/**
 * @typedef {{ refundExecutiveThresholdNgn?: number }} RefundGovernanceLimits
 */

/**
 * True when an actor with optional wildcard permission may approve a refund of this size alone.
 * @param {{ roleKey?: string } | null | undefined} actor
 * @param {(perm: string) => boolean} hasPermission - e.g. userHasPermission(actor, perm)
 * @param {number} approvedAmountNgn
 * @param {RefundGovernanceLimits | null | undefined} limits
 */
export function actorMayApproveRefundAmount(actor, hasPermission, approvedAmountNgn, limits) {
  const amt = Number(approvedAmountNgn) || 0;
  const hi = limits?.refundExecutiveThresholdNgn ?? REFUND_MD_APPROVAL_THRESHOLD_NGN;
  /** Strictly greater than threshold requires executive (amounts at or below threshold do not). */
  if (amt <= hi) return true;
  if (hasPermission('*')) return true;
  const rk = String(actor?.roleKey || '').trim().toLowerCase();
  if (rk === 'admin') return true;
  return isExecutiveRoleKey(rk);
}

/**
 * @typedef {{ expenseExecutiveThresholdNgn?: number }} PaymentGovernanceLimits
 */

/**
 * True when actor may approve a non-refund-like payment request of this amount.
 * At or below expense threshold: branch manager (or executive) with finance.approve.
 * Above threshold: executive (or admin) with finance.approve.
 * @param {{ roleKey?: string } | null | undefined} actor
 * @param {(perm: string) => boolean} hasPermission
 * @param {number} amountRequestedNgn
 * @param {string | null | undefined} expenseCategory
 * @param {PaymentGovernanceLimits | null | undefined} limits
 */
export function actorMayApprovePaymentRequestAmount(
  actor,
  hasPermission,
  amountRequestedNgn,
  expenseCategory,
  limits
) {
  if (isRefundLikeExpenseCategory(expenseCategory)) {
    return true;
  }
  const amt = Number(amountRequestedNgn) || 0;
  const expenseT = limits?.expenseExecutiveThresholdNgn ?? EXPENSE_MD_APPROVAL_THRESHOLD_NGN;
  if (hasPermission('*')) return true;
  const rk = String(actor?.roleKey || '').trim().toLowerCase();
  if (rk === 'admin') return true;
  if (!hasPermission('finance.approve')) return false;
  if (amt > expenseT) {
    return isExecutiveRoleKey(rk);
  }
  return isBranchExpenseApproverRoleKey(rk) || isExecutiveRoleKey(rk);
}
