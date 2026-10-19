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

/**
 * A5: read an over-quote approval from a pay request body (`overQuoteReason`; the supplier
 * route also accepts the old `mdNote`). Returns the approval when the actor may give it,
 * otherwise the reason it was not accepted — used only if the payment really is above quote.
 * @returns {{ overQuoteApproval: null | { reason: string, approverName: string, approverId: string, roleKey: string }, overQuoteApprovalError: null | object }}
 */
export function overQuoteApprovalFromBody(actor, body = {}, subject) {
  const reason = String(body?.overQuoteReason ?? body?.mdNote ?? '').trim();
  if (!reason) return { overQuoteApproval: null, overQuoteApprovalError: null };
  const ov = assertBmOmOverride({ actor, reason, subject });
  if (!ov.ok) return { overQuoteApproval: null, overQuoteApprovalError: ov };
  return {
    overQuoteApproval: {
      reason: ov.reason,
      approverName: ov.approver.name,
      approverId: ov.approver.id,
      roleKey: ov.approver.roleKey,
    },
    overQuoteApprovalError: null,
  };
}
