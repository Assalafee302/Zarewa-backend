/** @typedef {{ roleKey?: string; role?: string; permissions?: string[] }} ProductionGateActor */

export const PRODUCTION_GATE_OVERRIDE_NOTE_MIN_LEN = 8;

/**
 * @param {ProductionGateActor | null | undefined} actor
 */
export function userMayApproveProductionGate(actor) {
  if (!actor) return false;
  const perms = Array.isArray(actor.permissions) ? actor.permissions : [];
  if (perms.includes('*')) return true;
  const rk = String(actor.roleKey || actor.role || '').trim().toLowerCase();
  return rk === 'admin' || rk === 'md' || rk === 'sales_manager';
}

/**
 * @param {string} note
 */
export function productionGateOverrideNoteValid(note) {
  return String(note || '').trim().length >= PRODUCTION_GATE_OVERRIDE_NOTE_MIN_LEN;
}
