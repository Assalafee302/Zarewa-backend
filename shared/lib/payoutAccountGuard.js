/**
 * Finance Phase A (A1): a payout may only post to a payee whose profile has a bank
 * and a 10-digit account number. Used by the pay routes (refunds, expenses, haulage)
 * and by the desk cards, which show "Add payout account" instead of Pay.
 *
 * Missing: blank, a dash or em dash, "000", any placeholder word, all zeros, or
 * anything that is not exactly 10 digits once spaces and dashes are removed.
 * Owner D1 (2026-10-17): an 11-digit OPay / wallet number starting with 0 is accepted by
 * dropping the leading 0 and storing the 10 digits.
 * Owner D2 (2026-10-17): the account rule applies when the money leaves a bank / wallet
 * (Bank or POS treasury account). A Cash Office payout needs the recipient's name and a
 * voucher reference instead.
 */

export const PAYOUT_ACCOUNT_DIGITS = 10;

const PLACEHOLDER_TEXT = new Set(['', '-', '--', '—', '–', '.', 'n/a', 'na', 'nil', 'none', 'null', 'undefined', 'tbd', 'tba', '0', '00', '000']);

function clean(value) {
  return String(value ?? '').trim();
}

function isPlaceholder(value) {
  return PLACEHOLDER_TEXT.has(clean(value).toLowerCase());
}

/**
 * The 10-digit account to pay and store: digits once spaces and dashes are removed, with the
 * leading 0 dropped from an 11-digit wallet number (D1). '' when it is not a usable 10 digits.
 */
export function payoutAccountDigits(value) {
  const compact = clean(value).replace(/[\s-]/g, '');
  if (!/^\d+$/.test(compact)) return '';
  const ten = compact.length === 11 && compact.startsWith('0') ? compact.slice(1) : compact;
  return ten.length === PAYOUT_ACCOUNT_DIGITS && !/^0+$/.test(ten) ? ten : '';
}

/**
 * @param {{ bankName?: string, accountNo?: string }} account
 * @returns {string} '' when the payee can be paid; otherwise what is missing, in plain words
 */
export function payoutAccountProblem(account = {}) {
  const bankName = clean(account.bankName);
  const accountNo = clean(account.accountNo);
  const bankMissing = isPlaceholder(bankName);
  const accountMissing = isPlaceholder(accountNo) || !payoutAccountDigits(accountNo);
  if (bankMissing && accountMissing) return 'No payout bank or account number on the payee profile.';
  if (bankMissing) return 'No payout bank on the payee profile.';
  if (accountMissing) {
    return accountNo && !isPlaceholder(accountNo)
      ? `Payout account "${accountNo}" is not a ${PAYOUT_ACCOUNT_DIGITS}-digit account (or an 11-digit wallet number starting with 0).`
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

/** D2: a treasury account of type Cash is the Cash Office; Bank and POS are bank / wallet. */
export function treasuryAccountIsCashOffice(accountType) {
  return /^cash$/i.test(clean(accountType));
}

/** D2: a Cash Office payout records who took the cash and the voucher it was paid on. */
export function cashOfficePayoutProblem({ recipientName, voucherReference } = {}) {
  const name = clean(recipientName);
  const voucher = clean(voucherReference);
  if (name.length < 3 && voucher.length < 3) return 'A Cash Office payout needs the recipient’s name and the voucher reference.';
  if (name.length < 3) return 'A Cash Office payout needs the recipient’s name.';
  if (voucher.length < 3) return 'A Cash Office payout needs the voucher reference.';
  return '';
}

/**
 * D2: which rule a payout must pass, from the treasury accounts it is paid from.
 * Bank / wallet lines (or no lines, e.g. a wallet release) need every payee's account;
 * Cash Office lines need recipient name + voucher reference. A split payout needs both.
 * @param {{ accountTypes: string[], payees: object[], cash?: { recipientName?: string, voucherReference?: string } }} p
 */
export function payoutRouteBlock({ accountTypes = [], payees = [], cash = {} } = {}) {
  const types = Array.isArray(accountTypes) ? accountTypes : [];
  const hasCash = types.some((t) => treasuryAccountIsCashOffice(t));
  const hasBank = !types.length || types.some((t) => !treasuryAccountIsCashOffice(t));
  if (hasBank) {
    const block = payoutAccountBlock(payees);
    if (block) return block;
  }
  if (hasCash) {
    const problem = cashOfficePayoutProblem(cash);
    if (problem) return { ok: false, code: 'CASH_OFFICE_VOUCHER_REQUIRED', error: problem };
  }
  return null;
}
