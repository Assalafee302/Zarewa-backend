/**
 * Uncleared-receipt till hold override rules for refund payout.
 * Frontend copies via `npm run sync:shared` → src/shared/lib/refundUnclearedPayoutHold.js
 */

/** Cashiers may override a small held slice (with a mandatory note); larger holds need BM/HoA/admin. */
export const CASHIER_UNCLEARED_HOLD_OVERRIDE_MAX_NGN = 50_000;

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
 * Cashiers: only when held ≤ CASHIER_UNCLEARED_HOLD_OVERRIDE_MAX_NGN (note still required at pay).
 * BM / HoA / admin / refunds.approve / finance.approve: full override.
 * MD/CEO/chairman: never (they are blocked from customer-refund pay entirely).
 * Cashier role is checked before approve permissions so a cashier with finance.approve
 * still only gets the small-hold path (not a full BM-style override).
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
    return held > 0 && held <= CASHIER_UNCLEARED_HOLD_OVERRIDE_MAX_NGN;
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
