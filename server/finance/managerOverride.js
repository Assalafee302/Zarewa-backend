/**
 * Finance Phase A: Branch Manager / Operations Manager override with a reason.
 * The signed-in actor must hold a BM/OM-level role (Branch Manager, Sales Manager, OM, Admin, MD).
 * Reuses the coil-correction control so the role list and reason checks stay in one place.
 */
import { correctionReasonBlock, userIsBranchManagerOrOm } from '../operations/coilCorrectionControl.js';

/**
 * @param {{ actor: object, reason?: string, subject: string }} p
 * @returns {{ ok: true, reason: string, approver: { id: string, name: string, roleKey: string } } | { ok: false, code: string, error: string }}
 */
export function assertBmOmOverride({ actor, reason, subject }) {
  if (!userIsBranchManagerOrOm(actor)) {
    return {
      ok: false,
      code: 'MANAGER_OVERRIDE_REQUIRED',
      error: `Only a Branch Manager or Operations Manager can approve ${subject}.`,
    };
  }
  const text = String(reason || '').trim();
  const reasonBlock = correctionReasonBlock(text);
  if (reasonBlock) {
    return { ok: false, code: 'OVERRIDE_REASON_REQUIRED', error: reasonBlock.replace('this correction', subject) };
  }
  return {
    ok: true,
    reason: text,
    approver: {
      id: String(actor?.id || ''),
      name: String(actor?.displayName || actor?.username || ''),
      roleKey: String(actor?.roleKey || actor?.role_key || ''),
    },
  };
}

export { userIsBranchManagerOrOm };
