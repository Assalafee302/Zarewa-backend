/**
 * Production payment gate overrides:
 * - Some payment below branch threshold → Branch Manager or MD may approve.
 * - Zero payment → MD or admin only.
 * Frontend copies via `npm run sync:shared` → src/shared/lib/productionGateAccess.js
 *
 * Callers may pass an actor object (API) or a role-key string (SPA), and paid amount
 * as a number or `{ paidNgn }`.
 */

export const PRODUCTION_GATE_OVERRIDE_NOTE_MIN_LEN = 8;

/** @typedef {'branch_manager' | 'md' | 'admin'} ProductionGateApprovalLevel */

function roleKey(actorOrRoleKey) {
  if (actorOrRoleKey && typeof actorOrRoleKey === 'object') {
    return String(actorOrRoleKey.roleKey || actorOrRoleKey.role || '').trim().toLowerCase();
  }
  return String(actorOrRoleKey || '').trim().toLowerCase();
}

function paidNgnFromArg(paidOrOpts) {
  if (paidOrOpts != null && typeof paidOrOpts === 'object') return paidOrOpts.paidNgn;
  return paidOrOpts;
}

/**
 * @param {number | string | null | undefined} paidNgn
 */
export function quotationHasRecordedPayment(paidNgn) {
  return Math.round(Number(paidNgn) || 0) > 0;
}

/**
 * @param {string | { roleKey?: string; role?: string; permissions?: string[] } | null | undefined} actorOrRoleKey
 * @returns {ProductionGateApprovalLevel | null}
 */
export function productionGateApprovalLevelForActor(actorOrRoleKey) {
  if (typeof actorOrRoleKey === 'string') {
    const rk = roleKey(actorOrRoleKey);
    if (rk === 'admin') return 'admin';
    if (rk === 'md') return 'md';
    if (rk === 'sales_manager' || rk === 'branch_manager') return 'branch_manager';
    return null;
  }
  const actor = actorOrRoleKey;
  if (!actor) return null;
  const perms = Array.isArray(actor.permissions) ? actor.permissions : [];
  if (perms.includes('*')) return 'admin';
  const rk = roleKey(actor);
  if (rk === 'admin') return 'admin';
  if (rk === 'md') return 'md';
  if (rk === 'sales_manager' || rk === 'branch_manager') return 'branch_manager';
  return null;
}

/**
 * @param {string | { roleKey?: string; role?: string; permissions?: string[] } | null | undefined} actorOrRoleKey
 * @param {number | string | { paidNgn?: number | null } | null | undefined} [paidOrOpts]
 */
export function userMayApproveProductionGate(actorOrRoleKey, paidOrOpts = null) {
  const paidNgn = paidNgnFromArg(paidOrOpts);
  const level = productionGateApprovalLevelForActor(actorOrRoleKey);
  if (!level) return false;
  if (level === 'admin' || level === 'md') return true;
  if (level === 'branch_manager') {
    return quotationHasRecordedPayment(paidNgn);
  }
  return false;
}

/** SPA alias — same gate as {@link userMayApproveProductionGate}. */
export function canApproveProductionGate(actorOrRoleKey, paidOrOpts = null) {
  return userMayApproveProductionGate(actorOrRoleKey, paidOrOpts);
}

/**
 * @param {string} note
 */
export function productionGateOverrideNoteValid(note) {
  return String(note || '').trim().length >= PRODUCTION_GATE_OVERRIDE_NOTE_MIN_LEN;
}

/**
 * Whether an existing override stamp unlocks cutting list / production.
 * @param {{ manager_production_approved_at_iso?: string | null; managerProductionApprovedAtISO?: string | null; paid_ngn?: number | null; paidNgn?: number | null; manager_production_approval_level?: string | null; managerProductionApprovalLevel?: string | null }} qrow
 */
export function productionGateOverrideEffective(qrow) {
  const stamped = Boolean(
    String(qrow?.manager_production_approved_at_iso || qrow?.managerProductionApprovedAtISO || '').trim()
  );
  if (!stamped) return false;
  const paid = Math.round(Number(qrow?.paid_ngn ?? qrow?.paidNgn) || 0);
  if (quotationHasRecordedPayment(paid)) return true;
  const level = String(
    qrow?.manager_production_approval_level || qrow?.managerProductionApprovalLevel || ''
  ).toLowerCase();
  return level === 'md' || level === 'admin';
}

/**
 * @param {number | string | null | undefined} paidNgn
 */
export function productionGateOverrideDeniedMessage(paidNgn) {
  if (!quotationHasRecordedPayment(paidNgn)) {
    return 'Zero payment on this quotation requires Managing Director approval before cutting list / production.';
  }
  return 'Production gate override requires Branch Manager or Managing Director approval.';
}
