/** Payee account rules for a new refund and for matching it to a bank line. */

/**
 * TEMP: real 10/11-digit bank-account validation is off so placeholders can pass.
 * Set to `true` to restore rejection of blank, letter, zero, and short accounts.
 */
export const ENFORCE_REAL_PAYEE_ACCOUNT = false;

export function payeeAccountDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

/** Quote the receiver account so the UI can show exactly which value failed. */
function formatPayeeAccountForError(raw) {
  const text = String(raw || '').trim();
  if (!text) return '(blank)';
  return `"${text}"`;
}

/**
 * Always evaluates payee-account shape and names the exact failing value.
 * Prefer {@link payeeAccountRejection} at call sites (respects the TEMP flag).
 * @returns {string} empty when the account can be paid and reconciled
 */
export function payeeAccountRejectionReason(value) {
  const raw = String(value || '').trim();
  const shown = formatPayeeAccountForError(raw);
  if (!raw) return 'Refund payee account number is required (receiver account is blank).';
  if (/[a-z]/i.test(raw.replace(/[\s-]/g, ''))) {
    return `Refund payee account number must be the bank account digits, not a placeholder (receiver account ${shown}).`;
  }
  const digits = payeeAccountDigits(raw);
  if (!digits || /^0+$/.test(digits)) {
    return `Refund payee account number is required (receiver account ${shown} is not a usable number).`;
  }
  if (digits.length < 10 || digits.length > 11) {
    return `Refund payee account number must be the 10-digit bank account or the 11-digit OPay number (receiver account ${shown}).`;
  }
  return '';
}

/**
 * A usable payout account is a 10-digit bank account or an 11-digit OPay number.
 * Placeholders (blank, letters, all zeros, short numbers) are rejected when
 * {@link ENFORCE_REAL_PAYEE_ACCOUNT} is true. Errors name the exact receiver account.
 * @returns {string} empty when the account can be paid and reconciled
 */
export function payeeAccountRejection(value) {
  if (!ENFORCE_REAL_PAYEE_ACCOUNT) return '';
  return payeeAccountRejectionReason(value);
}

export function statementContainsPayeeAccount(description, accountNo) {
  const digits = payeeAccountDigits(accountNo);
  if (!digits) return false;
  return payeeAccountDigits(description).includes(digits);
}

export function refundIdFromSystemMatch(systemMatch) {
  const match = String(systemMatch || '').match(/\bRF-[A-Z]{2}-\d{2}-\d+\b/i);
  return match ? match[0].toUpperCase() : '';
}

/**
 * Open credit for the refund create gate: ledger advances plus still-refundable
 * quotation overpayment (cash above quote). Sales often posts one RECEIPT with no
 * OVERPAY_ADVANCE sibling — residual must still count so MD is not required for
 * that excess (e.g. QT-KD-26-1750 ₦483,050).
 */
export function effectiveRefundOpenCreditNgn({ ledgerOpenCreditNgn = 0, quotationOverpayResidualNgn = 0 } = {}) {
  return Math.max(
    0,
    Math.round(Number(ledgerOpenCreditNgn) || 0),
    Math.round(Number(quotationOverpayResidualNgn) || 0)
  );
}

/**
 * @returns {string} empty when the refund is within open credit or MD has approved it
 */
export function refundExceedsOpenCredit({ amountNgn, openCreditNgn, mdApproved }) {
  const amount = Math.round(Number(amountNgn) || 0);
  const credit = Math.round(Number(openCreditNgn) || 0);
  if (mdApproved || amount <= credit) return '';
  return `Refund of ₦${amount.toLocaleString('en-NG')} is larger than the customer's open credit of ₦${credit.toLocaleString('en-NG')}. MD approval is required.`;
}
