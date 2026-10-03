/**
 * Three Engr Attah Nicholas receipts (3 Oct 2026) stay pending until a manager
 * confirms the bank or cash. Amounts, dates, and quotation paid are unchanged.
 * Cashiers with finance.pay / finance.post cannot clear them.
 */

const HELD_RECEIPT_IDS = new Set(['LE-KD-26-1969', 'LE-KD-26-1971', 'LE-KD-26-1972']);

const MANAGER_ROLES = new Set([
  'admin',
  'md',
  'ceo',
  'chairman',
  'finance_manager',
  'manager',
  'head_of_accounts',
]);

export function actorMayConfirmHeldReceiptClearance(actor) {
  if (!actor) return false;
  const perms = Array.isArray(actor.permissions) ? actor.permissions : [];
  if (perms.includes('*') || perms.includes('finance.approve')) return true;
  return MANAGER_ROLES.has(String(actor.roleKey || '').trim().toLowerCase());
}

/**
 * @returns {null | { ok: false, code: string, error: string }}
 */
export function heldReceiptClearanceBlock(receiptId, actor) {
  const id = String(receiptId || '').trim();
  if (!HELD_RECEIPT_IDS.has(id)) return null;
  if (actorMayConfirmHeldReceiptClearance(actor)) return null;
  return {
    ok: false,
    code: 'MANAGER_BANK_CASH_CONFIRM_REQUIRED',
    error: 'A manager must confirm the bank or cash before this receipt can be cleared.',
  };
}
