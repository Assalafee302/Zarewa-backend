/**
 * Refund report v2 (Reports round 2, A3). Pure: refunds + treasury + bank recon in → one row per refund payout
 * (treasury line) in the period, sorted by payment date then account, with payee, approver, account debited
 * and BKR id, plus red flags.
 *
 * Flags (exceptions, red):
 *   - payee ≠ customer (name tokens do not match; company-cut payouts excepted)
 *   - payee = approver
 *   - payee matches a staff / user name (requested-by, approved-by, paid-by names, payment-request staff payees,
 *     and any staff list passed in) — there is no staff master in the report data
 *   - the same payee receives refunds for 3+ different customers in the period
 *   - refund marked paid in the period with no treasury payout line
 * Under review (amber): no payee recorded; bank payout with no bank-statement link.
 */

export const REFUND_PAYOUT_TYPES = ['REFUND_PAYOUT', 'REFUND_COMPANY_CUT_PAYOUT'];
export const FLAG_PAYEE_NOT_CUSTOMER = 'Payee is not the customer';
export const FLAG_PAYEE_IS_APPROVER = 'Payee is the approver';
export const FLAG_PAYEE_IS_STAFF = 'Payee matches a staff / user name';
export const FLAG_PAID_NO_TREASURY = 'Marked paid, no treasury payout line';
export const FLAG_PAYEE_MANY_CUSTOMERS = 'Same payee for several customers';
/** A payee who receives refunds for this many different customers in the period is flagged. */
export const PAYEE_MANY_CUSTOMERS_MIN = 3;
export const REVIEW_NO_PAYEE = 'No payee recorded';
export const REVIEW_NO_BANK_LINK = 'Bank payout not on the bank statement (no BKR link)';

const day = (v) => String(v || '').slice(0, 10);
const ngn = (v) => Math.round(Number(v) || 0);
const TITLES = new Set(['alhaji', 'alh', 'hajiya', 'mal', 'malam', 'mallam', 'engr', 'eng', 'mr', 'mrs', 'miss', 'dr', 'arc', 'barr', 'chief', 'cap', 'capt', 'client', 'customer']);

/** Name → comparable tokens (lower case letters, titles dropped, 3+ letters). */
export function nameTokens(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[^a-z\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !TITLES.has(t));
}

const tokenMatch = (a, b) => a === b || (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a)));

/** Same person by name: at least one token in common (a 4+ letter prefix counts: "atta" ~ "attah"). */
export function sameName(a, b) {
  const x = nameTokens(a);
  const y = nameTokens(b);
  if (!x.length || !y.length) return false;
  return x.some((t) => y.some((u) => tokenMatch(t, u)));
}

/** Stricter: every token of the shorter name is in the longer one (for payee = approver / staff). */
export function samePerson(a, b) {
  const x = nameTokens(a);
  const y = nameTokens(b);
  if (!x.length || !y.length) return false;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.every((t) => long.some((u) => tokenMatch(t, u)));
}

function accountLabel(t) {
  const name = String(t.accountName || '').trim();
  const bank = String(t.bankName || '').trim();
  if (String(t.accountType || '').toLowerCase() === 'cash') return name || 'Cash';
  return bank && name ? `${name} (${bank})` : name || bank || String(t.treasuryAccountId ?? '');
}

/**
 * @param {object} input
 * @param {object[]} input.refunds
 * @param {object[]} input.treasuryMovements — must cover the period
 * @param {object[]} [input.bankRecon]
 * @param {object[]} [input.paymentRequests] — staff payee names (staffDisplayName)
 * @param {string[]} [input.staffNames]
 * @param {string} input.startDate
 * @param {string} input.endDate
 */
export function buildRefundReport(input = {}) {
  const { refunds = [], treasuryMovements = [], bankRecon = [], paymentRequests = [], staffNames = [], startDate = '', endDate = '' } = input;
  const inPeriod = (iso) => {
    const d = day(iso);
    return Boolean(d) && (!startDate || d >= startDate) && (!endDate || d <= endDate);
  };
  const refundById = new Map(refunds.map((r) => [String(r.refundID || r.id || '').trim(), r]));
  const bankLineByMovement = new Map();
  for (const b of bankRecon) {
    for (const hit of String(b?.systemMatch || '').matchAll(/TM-[A-Z]{2,4}-\d{2}-\d+/gi)) {
      const id = hit[0].toUpperCase();
      if (!bankLineByMovement.has(id)) bankLineByMovement.set(id, String(b.id || ''));
    }
  }
  const staff = [
    ...staffNames,
    ...refunds.flatMap((r) => [r.requestedBy, r.approvedBy, r.paidBy]),
    ...paymentRequests.map((p) => p.staffDisplayName),
  ]
    .map((n) => String(n || '').trim())
    .filter((n) => nameTokens(n).length);
  const staffList = [...new Set(staff)];

  const payouts = treasuryMovements.filter((t) => REFUND_PAYOUT_TYPES.includes(t.type) && inPeriod(t.postedAtISO));
  const paidRefundIds = new Set();
  const rows = payouts.map((t) => {
    const refundID = String(t.sourceId || '').trim();
    const r = refundById.get(refundID) || {};
    paidRefundIds.add(refundID);
    const isCompanyCut = t.type === 'REFUND_COMPANY_CUT_PAYOUT';
    const payeeName = String(r.payeeName || '').trim();
    const customerName = String(r.customer || r.customerName || '').trim();
    const approvedBy = String(r.approvedBy || '').trim();
    const isCash = String(t.accountType || '').toLowerCase() === 'cash';
    const bankLineId = bankLineByMovement.get(String(t.id).toUpperCase()) || '';
    const flags = [];
    const review = [];
    if (!payeeName) review.push(REVIEW_NO_PAYEE);
    else {
      if (!isCompanyCut && customerName && !sameName(payeeName, customerName)) flags.push(FLAG_PAYEE_NOT_CUSTOMER);
      if (approvedBy && samePerson(payeeName, approvedBy)) flags.push(FLAG_PAYEE_IS_APPROVER);
      const staffHit = staffList.find((n) => samePerson(payeeName, n) && !sameName(n, customerName));
      if (staffHit) flags.push(`${FLAG_PAYEE_IS_STAFF} (${staffHit})`);
    }
    if (!isCash && !bankLineId) review.push(REVIEW_NO_BANK_LINK);
    return {
      paidDateISO: day(t.postedAtISO),
      treasuryMovementId: String(t.id),
      type: t.type,
      refundID,
      bankLineId,
      accountDebited: accountLabel(t),
      treasuryAccountId: t.treasuryAccountId,
      amountNgn: -ngn(t.amountNgn),
      customerID: String(r.customerID || '').trim(),
      customerName,
      quotationRef: String(r.quotationRef || '').trim(),
      payeeName,
      payeeBank: [String(r.payeeBankName || '').trim(), String(r.payeeAccountNo || '').trim()].filter(Boolean).join(' '),
      requestedBy: String(r.requestedBy || '').trim(),
      requestedAtISO: day(r.requestedAtISO),
      approvedBy,
      approvedAtISO: day(r.approvalDate),
      paidBy: String(t.createdByName || t.createdBy || r.paidBy || '').trim(),
      reason: String(r.reasonCategory || '').replace(/[[\]"]/g, '').replace(/,/g, ', '),
      status: String(r.status || '').trim(),
      flags,
      review,
      severity: flags.length ? 'exception' : review.length ? 'review' : '',
      createdAtISO: String(t.createdAtISO || ''),
    };
  });

  // Refund records marked paid in the period with no treasury payout.
  const paidNoTreasury = refunds
    .filter((r) => ngn(r.paidAmountNgn) > 0 && inPeriod(r.paidAtISO) && !paidRefundIds.has(String(r.refundID || r.id || '').trim()))
    .filter((r) => !treasuryMovements.some((t) => REFUND_PAYOUT_TYPES.includes(t.type) && String(t.sourceId || '').trim() === String(r.refundID || '').trim()))
    .map((r) => ({
      refundID: String(r.refundID || r.id || ''),
      customerName: String(r.customer || r.customerName || ''),
      quotationRef: String(r.quotationRef || ''),
      paidDateISO: day(r.paidAtISO),
      amountNgn: ngn(r.paidAmountNgn),
      payeeName: String(r.payeeName || ''),
      flags: [FLAG_PAID_NO_TREASURY],
      severity: 'exception',
    }));

  // Approved / pending, not yet paid (outstanding), requested in the period.
  const notPaid = refunds
    .filter((r) => !['Rejected', 'Cancelled', 'Paid'].includes(String(r.status || '').trim()) && inPeriod(r.requestedAtISO))
    .map((r) => {
      const approved = ngn(r.approvedAmountNgn || r.amountNgn);
      return {
        refundID: String(r.refundID || r.id || ''),
        requestedAtISO: day(r.requestedAtISO),
        customerName: String(r.customer || r.customerName || ''),
        quotationRef: String(r.quotationRef || ''),
        status: String(r.status || ''),
        approvedNgn: approved,
        paidNgn: ngn(r.paidAmountNgn),
        creditAppliedNgn: ngn(r.creditAppliedNgn),
        outstandingNgn: Math.max(0, approved - ngn(r.paidAmountNgn) - ngn(r.creditAppliedNgn)),
        requestedBy: String(r.requestedBy || ''),
        approvedBy: String(r.approvedBy || ''),
      };
    })
    .filter((r) => r.outstandingNgn > 0)
    .sort((a, b) => a.requestedAtISO.localeCompare(b.requestedAtISO) || a.refundID.localeCompare(b.refundID));

  // Same payee for several customers (names compared on their tokens, titles dropped).
  const payeeKey = (n) => nameTokens(n).sort().join(' ');
  const customersByPayee = new Map();
  for (const r of rows) {
    if (!r.payeeName || r.type !== 'REFUND_PAYOUT') continue;
    const k = payeeKey(r.payeeName);
    const set = customersByPayee.get(k) || new Set();
    set.add(r.customerID || r.customerName);
    customersByPayee.set(k, set);
  }
  for (const r of rows) {
    const set = r.payeeName && r.type === 'REFUND_PAYOUT' ? customersByPayee.get(payeeKey(r.payeeName)) : null;
    if (set && set.size >= PAYEE_MANY_CUSTOMERS_MIN && r.flags.includes(FLAG_PAYEE_NOT_CUSTOMER)) {
      r.flags.push(`${FLAG_PAYEE_MANY_CUSTOMERS} (${set.size} in the period)`);
      r.severity = 'exception';
    }
  }

  rows.sort(
    (a, b) =>
      a.paidDateISO.localeCompare(b.paidDateISO) ||
      a.accountDebited.localeCompare(b.accountDebited) ||
      a.treasuryMovementId.localeCompare(b.treasuryMovementId)
  );

  const byAccount = new Map();
  for (const r of rows) byAccount.set(r.accountDebited, (byAccount.get(r.accountDebited) || 0) + r.amountNgn);
  const count = (pred) => rows.filter(pred).length;
  return {
    startDate,
    endDate,
    rows,
    paidNoTreasury,
    notPaid,
    totals: {
      paidNgn: rows.reduce((s, r) => s + r.amountNgn, 0),
      payoutCount: rows.length,
      refundsPaidNgn: rows.filter((r) => r.type === 'REFUND_PAYOUT').reduce((s, r) => s + r.amountNgn, 0),
      companyCutNgn: rows.filter((r) => r.type === 'REFUND_COMPANY_CUT_PAYOUT').reduce((s, r) => s + r.amountNgn, 0),
      byAccount: [...byAccount.entries()].map(([account, amountNgn]) => ({ account, amountNgn })).sort((a, b) => b.amountNgn - a.amountNgn),
      notPaidNgn: notPaid.reduce((s, r) => s + r.outstandingNgn, 0),
    },
    counts: {
      exceptions: count((r) => r.severity === 'exception') + paidNoTreasury.length,
      review: count((r) => r.severity === 'review'),
      payeeNotCustomer: count((r) => r.flags.includes(FLAG_PAYEE_NOT_CUSTOMER)),
      payeeIsApprover: count((r) => r.flags.includes(FLAG_PAYEE_IS_APPROVER)),
      payeeIsStaff: count((r) => r.flags.some((f) => f.startsWith(FLAG_PAYEE_IS_STAFF))),
      payeeManyCustomers: count((r) => r.flags.some((f) => f.startsWith(FLAG_PAYEE_MANY_CUSTOMERS))),
      noPayee: count((r) => r.review.includes(REVIEW_NO_PAYEE)),
      noBankLink: count((r) => r.review.includes(REVIEW_NO_BANK_LINK)),
    },
    staffNamesUsed: staffList.length,
  };
}
