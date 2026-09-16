/**
 * Uncleared-receipt till hold override rules for refund payout.
 * Frontend copies via `npm run sync:shared` → src/shared/lib/refundUnclearedPayoutHold.js
 *
 * Till payable is already net of company cut and any refund-fund credit applied from a
 * confirmed receipt. Uncleared holds only gate the remaining cash slice — cashiers may
 * release that slice with a mandatory note (any size). BM/HoA/admin same path.
 */

/**
 * Legacy UI hint for “small hold” copy. Cashiers may override any held size with a note;
 * this cap is no longer enforced on the override gate.
 */
export const CASHIER_UNCLEARED_HOLD_OVERRIDE_MAX_NGN = Number.MAX_SAFE_INTEGER;

function normalizeRoleKey(actor) {
  return String(actor?.roleKey || actor?.role_key || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
}

function isAdminTrialActor(actor, hasPermission) {
  if (typeof hasPermission === 'function' && hasPermission('*')) return true;
  const perms = Array.isArray(actor?.permissions) ? actor.permissions : [];
  if (perms.includes('*')) return true;
  return normalizeRoleKey(actor) === 'admin';
}

/**
 * Who may till-pay while the payee still has unconfirmed receipts on this refund's job.
 * Cashiers / BM / HoA / admin / refunds.approve / finance.approve: override with note
 * (pay path still requires ≥10-char note for non-admin).
 * MD/CEO/chairman: never (blocked from customer-refund pay entirely).
 *
 * @param {{ roleKey?: string, role_key?: string, permissions?: string[] } | null | undefined} actor
 * @param {(perm: string) => boolean} [hasPermission]
 * @param {{ heldNetNgn?: number }} [opts]
 */
export function actorMayOverrideRefundUnclearedPayoutHold(actor, hasPermission, opts = {}) {
  if (isAdminTrialActor(actor, hasPermission)) return true;
  const rk = normalizeRoleKey(actor);
  if (rk === 'md' || rk === 'ceo' || rk === 'chairman') return false;
  if (rk === 'cashier') {
    const held = Math.max(0, Math.round(Number(opts?.heldNetNgn) || 0));
    return held > 0;
  }
  if (rk === 'sales_manager' || rk === 'branch_manager' || rk === 'finance_manager' || rk === 'admin') {
    return true;
  }
  if (typeof hasPermission === 'function') {
    if (hasPermission('refunds.approve') || hasPermission('finance.approve')) return true;
  }
  const perms = Array.isArray(actor?.permissions) ? actor.permissions : [];
  if (perms.includes('refunds.approve') || perms.includes('finance.approve')) return true;
  return false;
}
