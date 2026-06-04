/**
 * Phase B3a — trial stabilisation flags (warnings only; strict enforcement off by default).
 */

function envFlag(name, defaultOn) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (raw === '') return defaultOn;
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

/** @returns {{
 *   strictCashierRbac: boolean,
 *   allowAccountantReceiptConfirmation: boolean,
 *   enforceDualControlPayments: boolean,
 *   phase: string,
 * }} */
export function readFinanceFeatureFlags() {
  return {
    phase: 'B3a',
    strictCashierRbac: envFlag('STRICT_CASHIER_RBAC', false),
    allowAccountantReceiptConfirmation: envFlag('ALLOW_ACCOUNTANT_RECEIPT_CONFIRMATION', true),
    enforceDualControlPayments: envFlag('ENFORCE_DUAL_CONTROL_PAYMENTS', false),
  };
}

/**
 * When strict flags are on, callers may block mutations. B3a keeps these off.
 * @param {'same_user_approve_pay' | 'cashier_receipt_confirm' | 'accountant_receipt_confirm'} kind
 */
export function financeStrictBlockWouldApply(kind) {
  const f = readFinanceFeatureFlags();
  if (kind === 'same_user_approve_pay') return f.enforceDualControlPayments;
  if (kind === 'cashier_receipt_confirm') return f.strictCashierRbac;
  if (kind === 'accountant_receipt_confirm') {
    return f.strictCashierRbac && !f.allowAccountantReceiptConfirmation;
  }
  return false;
}
