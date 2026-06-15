/**
 * Production payment gate — BM / MD override (not sales officers).
 */
export const PRODUCTION_GATE_OVERRIDE_NOTE_MIN_LEN = 8;

function roleKey(actor) {
  return String(actor?.roleKey || actor?.role || '').trim().toLowerCase();
}

/**
 * Branch manager (`sales_manager`), MD, or admin may record production gate override.
 * @param {{ roleKey?: string; role?: string; permissions?: string[] } | null | undefined} actor
 */
export function userMayApproveProductionGate(actor) {
  if (!actor) return false;
  const perms = Array.isArray(actor.permissions) ? actor.permissions : [];
  if (perms.includes('*')) return true;
  const rk = roleKey(actor);
  return rk === 'admin' || rk === 'md' || rk === 'sales_manager';
}

/**
 * @param {string} note
 */
export function productionGateOverrideNoteValid(note) {
  return String(note || '').trim().length >= PRODUCTION_GATE_OVERRIDE_NOTE_MIN_LEN;
}
