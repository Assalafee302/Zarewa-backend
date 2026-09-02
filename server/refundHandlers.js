/**
 * Phase 11A — refund approval / payout segregation helpers.
 * Enforced in decideRefundRequest (controlOps) and payRefundEntry (writeOps).
 */
import { financeStrictBlockWouldApply } from './financeFeatureFlags.js';

/** @param {unknown} name */
export function normalizeRefundActorName(name) {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * Admin may request → approve → pay during trial (logged in audit_log / approval_actions).
 * @param {{ roleKey?: string, role_key?: string, permissions?: string[] } | null | undefined} actor
 * @param {(perm: string) => boolean} hasPermission
 */
export function isRefundAdminTrialActor(actor, hasPermission) {
  if (typeof hasPermission === 'function' && hasPermission('*')) return true;
  const perms = Array.isArray(actor?.permissions) ? actor.permissions : [];
  if (perms.includes('*')) return true;
  const rk = String(actor?.roleKey || actor?.role_key || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
  return rk === 'admin';
}

/**
 * Cash still payable from till/bank for this refund.
 * Partner-wallet open credits stay off till (withdrawals desk). Admin may till-pay the
 * leftover held-for-uncleared slice that was never credited to the wallet.
 */
export function refundTillPayableNgn({
  cashOutstandingNgn = 0,
  heldNetNgn = 0,
  adminMayPayUncleared = false,
  openWalletNgn = 0,
} = {}) {
  const cash = Math.max(0, Math.round(Number(cashOutstandingNgn) || 0));
  const held = Math.max(0, Math.round(Number(heldNetNgn) || 0));
  const wallet = Math.max(0, Math.round(Number(openWalletNgn) || 0));
  if (wallet > 0) {
    if (!adminMayPayUncleared) return 0;
    return Math.max(0, cash - wallet);
  }
  if (adminMayPayUncleared) return cash;
  return Math.max(0, cash - held);
}

/**
 * Cashiers cannot till-pay a refund while the payee has unconfirmed receipts.
 * Admin (trial actor) may pay out anyway — logged on refund.pay.
 */
export function actorMayOverrideRefundUnclearedPayoutHold(actor, hasPermission) {
  return isRefundAdminTrialActor(actor, hasPermission);
}

/**
 * Cashiers execute payouts only — not refund approval decisions.
 * @param {{ roleKey?: string } | null | undefined} actor
 * @param {(perm: string) => boolean} hasPermission
 */
export function assertCashierMayNotApproveRefund(actor, hasPermission) {
  if (isRefundAdminTrialActor(actor, hasPermission)) {
    return { ok: true, adminTrial: true };
  }
  const rk = String(actor?.roleKey || '').trim().toLowerCase();
  if (rk === 'cashier') {
    return {
      ok: false,
      error: 'Cashiers may only pay approved refunds. Escalate approval to a manager or MD.',
    };
  }
  return { ok: true, adminTrial: false };
}

/**
 * Block requester from approving their own refund (admin trial exempt).
 * @param {Record<string, unknown>} row
 * @param {{ id?: string; roleKey?: string; displayName?: string; username?: string } | null | undefined} actor
 * @param {(perm: string) => boolean} hasPermission
 */
export function assertRefundApproverNotRequester(row, actor, hasPermission) {
  if (isRefundAdminTrialActor(actor, hasPermission)) {
    return { ok: true, adminTrial: true, bypass: 'admin_trial' };
  }
  const requesterId = row?.requested_by_user_id != null ? String(row.requested_by_user_id) : '';
  const approverId = actor?.id != null ? String(actor.id) : '';
  if (requesterId && approverId && requesterId === approverId) {
    return {
      ok: false,
      error: 'You cannot approve a refund you requested. Another approver must review it.',
    };
  }
  const reqName = normalizeRefundActorName(row?.requested_by);
  const apprName = normalizeRefundActorName(actor?.displayName || actor?.username);
  if (reqName && apprName && reqName === apprName) {
    return {
      ok: false,
      error: 'You cannot approve a refund you requested. Another approver must review it.',
    };
  }
  return { ok: true, adminTrial: false };
}

/**
 * When ENFORCE_DUAL_CONTROL_PAYMENTS=1, block approver from paying the same refund (admin trial exempt).
 * @param {Record<string, unknown>} row
 * @param {{ id?: string; roleKey?: string; displayName?: string; username?: string } | null | undefined} actor
 * @param {(perm: string) => boolean} hasPermission
 */
export function assertRefundPayerNotApprover(row, actor, hasPermission) {
  if (isRefundAdminTrialActor(actor, hasPermission)) {
    return { ok: true, adminTrial: true, bypass: 'admin_trial' };
  }
  if (!financeStrictBlockWouldApply('same_user_approve_pay')) {
    return { ok: true, adminTrial: false };
  }
  const payerId = actor?.id != null ? String(actor.id) : '';
  const approverId = row?.approved_by_user_id != null ? String(row.approved_by_user_id) : '';
  if (approverId && payerId && approverId === payerId) {
    return {
      ok: false,
      error: 'You cannot pay out a refund you approved. Another finance user must execute the payout.',
    };
  }
  const payerName = normalizeRefundActorName(actor?.displayName || actor?.username);
  const approverName = normalizeRefundActorName(row?.approved_by);
  if (payerName && approverName && payerName === approverName) {
    return {
      ok: false,
      error: 'You cannot pay out a refund you approved. Another finance user must execute the payout.',
    };
  }
  return { ok: true, adminTrial: false };
}

const EXECUTIVE_REFUND_PAY_BLOCKED_ROLE_KEYS = new Set(['md', 'ceo', 'chairman']);

/**
 * MD/CEO/chairman keep finance.pay for expenses and treasury, but cannot pay customer refunds.
 * Admin trial still allowed. Dual-control (approver ≠ payer) is applied after this role gate.
 * @param {Record<string, unknown>} row
 * @param {{ id?: string; roleKey?: string; role_key?: string; displayName?: string; username?: string } | null | undefined} actor
 * @param {(perm: string) => boolean} hasPermission
 */
export function assertActorMayPayCustomerRefund(row, actor, hasPermission) {
  if (isRefundAdminTrialActor(actor, hasPermission)) {
    return { ok: true, adminTrial: true, bypass: 'admin_trial' };
  }
  const rk = String(actor?.roleKey || actor?.role_key || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
  if (EXECUTIVE_REFUND_PAY_BLOCKED_ROLE_KEYS.has(rk)) {
    return {
      ok: false,
      error:
        'Managing Director cannot pay customer refunds. Cashier or Head of Accounts must execute the payout.',
    };
  }
  return assertRefundPayerNotApprover(row, actor, hasPermission);
}
