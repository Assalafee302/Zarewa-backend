/**
 * Coil and production corrections (restore, re-post, finish-roll tail change)
 * post only with a real reason and manager-level approval.
 * Branch manager / OM / Admin / MD may post directly. Anyone else needs an
 * approved edit token whose approver holds one of those roles.
 */
import { normalizeRoleKey } from '../auth.js';
import { consumeEditApprovalInTransaction } from '../editApproval.js';

/** Roles that may post a coil/production correction without a second-party token. */
const CORRECTION_DIRECT_POST_ROLES = new Set([
  'branch_manager',
  'sales_manager',
  'operations_manager',
  'ops_manager',
  'admin',
  'md',
  'ceo',
  'chairman',
]);

const KEYBOARD_ROWS = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890'];

export function userIsBranchManagerOrOm(user) {
  const rk = normalizeRoleKey(user?.roleKey ?? user?.role_key);
  return CORRECTION_DIRECT_POST_ROLES.has(rk);
}

function isKeyboardOrRepeatedReason(text) {
  const compact = String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
  if (!compact) return true;
  if (/(.)\1{4,}/.test(compact)) return true;
  if (new Set(compact).size <= 2) return true;
  for (let size = 1; size <= Math.floor(compact.length / 3); size += 1) {
    if (compact.length % size !== 0) continue;
    const chunk = compact.slice(0, size);
    if (chunk.repeat(compact.length / size) === compact) return true;
  }
  for (const row of KEYBOARD_ROWS) {
    const sequences = [row, [...row].reverse().join('')];
    for (const seq of sequences) {
      for (let n = 6; n <= seq.length; n += 1) {
        for (let i = 0; i + n <= seq.length; i += 1) {
          if (compact.includes(seq.slice(i, i + n))) return true;
        }
      }
    }
  }
  return false;
}

/** @returns {string} empty when the reason may be used */
export function correctionReasonBlock(reason) {
  const text = String(reason || '').trim();
  if (text.length < 10) {
    return 'Enter a reason of at least 10 characters for this correction.';
  }
  if (isKeyboardOrRepeatedReason(text)) {
    return 'The reason must describe the correction. A repeated or keyboard pattern is not accepted.';
  }
  return '';
}

const APPROVAL_ERROR =
  'A Branch Manager, Operations Manager, Admin, or MD must approve this correction before it posts.';

/**
 * Manager-level roles may post directly. Otherwise an approved edit token from one of those roles is required.
 * Call consumeCorrectionApprovalTx inside the same transaction as the stock write.
 * @returns {{ ok: true, consumeId: string | null } | { ok: false, code: string, error: string }}
 */
export function assertCorrectionApproval(db, { actor, editApprovalId, entityKind, entityId }) {
  if (userIsBranchManagerOrOm(actor)) return { ok: true, consumeId: null };
  const aid = String(editApprovalId || '').trim();
  if (!aid) {
    return { ok: false, code: 'CORRECTION_APPROVAL_REQUIRED', error: APPROVAL_ERROR };
  }
  const row = db
    .prepare(
      `SELECT approved_by_user_id, status, entity_kind, entity_id, expires_at_iso
       FROM edit_approval_tokens WHERE id = ?`
    )
    .get(aid);
  const now = new Date().toISOString();
  if (
    !row ||
    row.status !== 'approved' ||
    String(row.entity_kind || '') !== String(entityKind || '') ||
    String(row.entity_id || '') !== String(entityId || '') ||
    (row.expires_at_iso && String(row.expires_at_iso) <= now)
  ) {
    return {
      ok: false,
      code: 'CORRECTION_APPROVAL_REQUIRED',
      error: 'This approval is missing, expired, or not for this correction.',
    };
  }
  const approver = db.prepare(`SELECT role_key FROM app_users WHERE id = ?`).get(row.approved_by_user_id);
  if (!userIsBranchManagerOrOm({ roleKey: approver?.role_key })) {
    return {
      ok: false,
      code: 'CORRECTION_APPROVAL_REQUIRED',
      error: 'This correction must be approved by a Branch Manager, Operations Manager, Admin, or MD.',
    };
  }
  return { ok: true, consumeId: aid };
}

export function consumeCorrectionApprovalTx(db, approvalId, entityKind, entityId) {
  consumeEditApprovalInTransaction(db, approvalId, entityKind, entityId);
}
