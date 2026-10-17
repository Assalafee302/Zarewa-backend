/**
 * Finance Phase A (A1): a payout may only post to a payee whose profile has a bank
 * and a 10-digit account number. Used by the pay routes (refunds, expenses, haulage)
 * and by the desk cards, which show "Add payout account" instead of Pay.
 *
 * Missing: blank, a dash or em dash, "000", any placeholder word, all zeros, or
 * anything that is not exactly 10 digits once spaces and dashes are removed.
 */

export const PAYOUT_ACCOUNT_DIGITS = 10;

const PLACEHOLDER_TEXT = new Set(['', '-', '--', '—', '–', '.', 'n/a', 'na', 'nil', 'none', 'null', 'undefined', 'tbd', 'tba', '0', '00', '000']);

function clean(value) {
  return String(value ?? '').trim();
}

function isPlaceholder(value) {
  return PLACEHOLDER_TEXT.has(clean(value).toLowerCase());
}

/** Digits of an account number once spaces and dashes are removed; '' when anything else is in it. */
export function payoutAccountDigits(value) {
  const compact = clean(value).replace(/[\s-]/g, '');
  return /^\d+$/.test(compact) ? compact : '';
}

/**
 * @param {{ bankName?: string, accountNo?: string }} account
 * @returns {string} '' when the payee can be paid; otherwise what is missing, in plain words
 */
export function payoutAccountProblem(account = {}) {
  const bankName = clean(account.bankName);
  const accountNo = clean(account.accountNo);
  const bankMissing = isPlaceholder(bankName);
  const digits = payoutAccountDigits(accountNo);
  const accountMissing =
    isPlaceholder(accountNo) || digits.length !== PAYOUT_ACCOUNT_DIGITS || /^0+$/.test(digits);
  if (bankMissing && accountMissing) return 'No payout bank or account number on the payee profile.';
  if (bankMissing) return 'No payout bank on the payee profile.';
  if (accountMissing) {
    return accountNo && !isPlaceholder(accountNo)
      ? `Payout account "${accountNo}" is not a ${PAYOUT_ACCOUNT_DIGITS}-digit account number.`
      : 'No payout account number on the payee profile.';
  }
  return '';
}

export function payoutAccountIsMissing(account = {}) {
  return payoutAccountProblem(account) !== '';
}

/**
 * Refuse a payout when any payee that will receive cash has no usable account.
 * @param {Array<{ label?: string, bankName?: string, accountNo?: string }>} payees
 * @returns {null | { ok: false, code: 'PAYOUT_ACCOUNT_MISSING', error: string, payees: Array<{ label: string, problem: string }> }}
 */
export function payoutAccountBlock(payees = []) {
  const missing = (Array.isArray(payees) ? payees : [])
    .map((p) => ({ label: clean(p?.label) || 'Payee', problem: payoutAccountProblem(p) }))
    .filter((p) => p.problem);
  if (!missing.length) return null;
  const first = missing[0];
  const more = missing.length > 1 ? ` (and ${missing.length - 1} more payee${missing.length > 2 ? 's' : ''})` : '';
  return {
    ok: false,
    code: 'PAYOUT_ACCOUNT_MISSING',
    error: `Add a payout account before paying. ${first.label}: ${first.problem}${more}`,
    payees: missing,
  };
}

/**
 * Which payees on a refund still have cash to receive. Paid cash is allocated to the
 * quote customer first, then to the other payees in order, the same way the desk shows it.
 * @param {Array<{ partyKind?: string, amountNgn?: number, payoutCancelled?: boolean }>} targets
 * @param {number} paidNgn treasury + wallet money already out on the refund
 */
export function refundPayeesStillOwed(targets = [], paidNgn = 0) {
  const list = (Array.isArray(targets) ? targets : [])
    .map((t, index) => ({ ...t, index }))
    .filter((t) => !t.payoutCancelled && Math.round(Number(t.amountNgn) || 0) > 0)
    .sort((a, b) => {
      const ac = a.partyKind === 'customer' ? 0 : 1;
      const bc = b.partyKind === 'customer' ? 0 : 1;
      return ac - bc || a.index - b.index;
    });
  let left = Math.max(0, Math.round(Number(paidNgn) || 0));
  const owed = [];
  for (const t of list) {
    const amount = Math.round(Number(t.amountNgn) || 0);
    const covered = Math.min(amount, left);
    left -= covered;
    if (amount - covered > 0) owed.push({ ...t, owedNgn: amount - covered });
  }
  return owed;
}

/** Payout account stored on a transport agent profile (profile_json). */
export function transportAgentPayoutAccount(profile = {}) {
  const p = profile && typeof profile === 'object' ? profile : {};
  return {
    payeeName: clean(p.payoutAccountName ?? p.bankAccountName),
    payeeBankName: clean(p.payoutBankName ?? p.bankName),
    payeeAccountNo: clean(p.payoutAccountNo ?? p.bankAccountNo),
  };
}
