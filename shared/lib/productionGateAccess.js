/**
 * Production payment gate overrides:
 * - Some payment below branch threshold → Branch Manager or MD may approve.
 * - Zero payment → MD or admin only.
 */

export const PRODUCTION_GATE_OVERRIDE_NOTE_MIN_LEN = 8;

/** @typedef {'branch_manager' | 'md' | 'admin'} ProductionGateApprovalLevel */

function roleKey(actor) {
  return String(actor?.roleKey || actor?.role || '').trim().toLowerCase();
}

/**
 * @param {number | string | null | undefined} paidNgn
 */
export function quotationHasRecordedPayment(paidNgn) {
  return Math.round(Number(paidNgn) || 0) > 0;
}

/**
 * @param {{ roleKey?: string; role?: string; permissions?: string[] } | null | undefined} actor
 * @returns {ProductionGateApprovalLevel | null}
 */
export function productionGateApprovalLevelForActor(actor) {
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
 * @param {{ roleKey?: string; role?: string; permissions?: string[] } | null | undefined} actor
 * @param {number | string | null | undefined} [paidNgn]
 */
export function userMayApproveProductionGate(actor, paidNgn = null) {
  const level = productionGateApprovalLevelForActor(actor);
  if (!level) return false;
  if (level === 'admin' || level === 'md') return true;
  if (level === 'branch_manager') {
    return quotationHasRecordedPayment(paidNgn);
  }
  return false;
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
