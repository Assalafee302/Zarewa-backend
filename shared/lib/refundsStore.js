/**
 * Refund requests — shared between Sales (create / approve) and Finance (pay out).
 * Live data comes from workspace snapshot; localStorage is legacy-only if present.
 */
import { effectiveOutstandingNgn } from './paymentOutstandingTolerance.js';
import { refundQuotationRefundsBlocked } from './quotationRefundsBlocked.js';

const STORAGE_KEY = 'zarewa.sales.refunds';

/** @typedef {'Pending'|'Approved'|'Partially paid'|'Rejected'|'Cancelled'|'Paid'} RefundStatus */

function normalizeLine(line) {
  return {
    label: String(line?.label ?? '').trim(),
    amountNgn: Number(line?.amountNgn) || 0,
  };
}

function normalizePayoutLine(line) {
  return {
    id: String(line?.id ?? ''),
    postedAtISO: String(line?.postedAtISO ?? ''),
    treasuryAccountId: line?.treasuryAccountId ?? '',
    accountName: String(line?.accountName ?? ''),
    amountNgn: Number(line?.amountNgn) || 0,
    reference: String(line?.reference ?? ''),
    note: String(line?.note ?? ''),
  };
}

export function refundApprovedAmount(r) {
  const requested = Number(r?.amountNgn) || 0;
  const approved = Number(r?.approvedAmountNgn);
  if (Number.isFinite(approved) && approved > 0) return approved;
  if (r?.status === 'Approved' || r?.status === 'Paid' || r?.status === 'Partially paid') return requested;
  return 0;
}

/** Till/cash still owed after paid + refund-fund apply, ignoring a stale settlement summary. */
export function refundCreditAdjustedOutstandingNgn(r) {
  const requested = Math.round(Number(r?.amountNgn ?? r?.amount_ngn) || 0);
  const approved = refundApprovedAmount(r);
  const paid = Math.round(Number(r?.paidAmountNgn ?? r?.paid_amount_ngn) || 0);
  const creditApplied = Math.round(Number(r?.creditAppliedNgn ?? r?.credit_applied_ngn) || 0);
  const leftoverAfterCredit = Math.max(0, requested - creditApplied);
  // Manager already approved the leftover after fund use — do not subtract credit twice.
  if (creditApplied > 0 && approved > 0 && approved <= leftoverAfterCredit + 1) {
    const tillPaid = Math.max(0, paid - creditApplied);
    return effectiveOutstandingNgn(approved, tillPaid);
  }
  const companyCut = Math.round(Number(r?.companyCutNgn ?? r?.settlementSummary?.companyCutNgn) || 0);
  const due = companyCut > 0 ? Math.max(0, approved - companyCut) : approved;
  return effectiveOutstandingNgn(due, Math.max(paid, creditApplied));
}

export function refundOutstandingAmount(r) {
  const fromMath = refundCreditAdjustedOutstandingNgn(r);
  const tillFromSummary = r?.settlementSummary?.tillPayableNgn;
  if (tillFromSummary != null && Number.isFinite(Number(tillFromSummary))) {
    return Math.min(fromMath, Math.max(0, Math.round(Number(tillFromSummary) || 0)));
  }
  const fromSummary = r?.settlementSummary?.cashOutstandingNgn;
  if (fromSummary != null && Number.isFinite(Number(fromSummary))) {
    // Prefer the lower figure: a cached summary can still show the pre-apply till due.
    return Math.min(fromMath, Math.max(0, Math.round(Number(fromSummary) || 0)));
  }
  return fromMath;
}

function roundRefundPayeeNgn(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

/** Name on the payee's own bank line — not the quotation customer. */
export function refundSplitPayeeLabel(split) {
  return String(
    split?.payoutAccount?.payeeName ??
      split?.payeeName ??
      split?.payee_name ??
      split?.partyName ??
      split?.recipientName ??
      ''
  ).trim();
}

/**
 * Staff share even when the split is stored as recipientKind "customer"
 * (claiming-staff bank on the quotation). Company cut is that marker.
 */
export function refundSplitIsStaffShare(split) {
  const kind = String(split?.recipientKind ?? split?.recipient_kind ?? '')
    .trim()
    .toLowerCase();
  if (kind === 'associated_staff' || kind === 'staff') return true;
  if (String(split?.recipientAssociatedStaffID ?? split?.recipient_associated_staff_id ?? '').trim()) {
    return true;
  }
  if (split?.staffBankAccountMatch === true || split?.forceClaimingStaffCut === true) return true;
  if (roundRefundPayeeNgn(split?.companyDeductionNgn) > 0) return true;
  return false;
}

function refundSplitOwnNetNgn(split) {
  const net = split?.netPayoutNgn;
  if (net != null && Number.isFinite(Number(net))) return Math.max(0, roundRefundPayeeNgn(net));
  const gross = roundRefundPayeeNgn(split?.grossNgn ?? split?.amountNgn);
  const cut = roundRefundPayeeNgn(split?.companyDeductionNgn);
  return Math.max(0, gross - cut);
}

/**
 * One cashier line per payee. Amounts stay on that person.
 * Cash already paid is taken from the smaller net first (the staff share, e.g. ₦67,840)
 * so it does not rewrite the other payee's ₦250,000 into a new figure on the same quotation.
 *
 * @param {Array<object>|null|undefined} splits
 * @param {{ quotationCustomer?: string, quotationRef?: string, paidNgn?: number }} [opts]
 */
export function buildRefundCashierPayoutLines(splits, opts = {}) {
  const list = Array.isArray(splits) ? splits : [];
  const quoteCustomer = String(opts.quotationCustomer || '').trim();
  const quotationRef = String(opts.quotationRef || '').trim();
  const draft = [];
  list.forEach((split, index) => {
    if (split?.payoutCancelled === true) return;
    const netNgn = refundSplitOwnNetNgn(split);
    const grossNgn = roundRefundPayeeNgn(split?.grossNgn ?? split?.amountNgn) || netNgn;
    if (netNgn <= 0 && grossNgn <= 0) return;
    const staffShare = refundSplitIsStaffShare(split);
    const payeeName =
      refundSplitPayeeLabel(split) || (staffShare ? 'Staff payee' : quoteCustomer || 'Customer payee');
    draft.push({
      index,
      key: `${staffShare ? 'staff' : 'customer'}:${index}:${payeeName}`,
      payeeName,
      payeeBankName: String(
        split?.payoutAccount?.payeeBankName ?? split?.payeeBankName ?? split?.payee_bank_name ?? ''
      ).trim(),
      payeeAccountNo: String(
        split?.payoutAccount?.payeeAccountNo ?? split?.payeeAccountNo ?? split?.payee_account_no ?? ''
      ).trim(),
      staffShare,
      roleLabel: staffShare ? 'Staff share' : 'Customer share',
      grossNgn,
      companyDeductionNgn: roundRefundPayeeNgn(split?.companyDeductionNgn),
      netNgn,
      quotationRef,
      quotationCustomer: quoteCustomer,
    });
  });
  if (!draft.length) return [];

  let left = Math.max(0, roundRefundPayeeNgn(opts.paidNgn));
  const paidByIndex = new Map();
  if (draft.length === 2) {
    const [small, large] = [...draft].sort((a, b) => a.netNgn - b.netNgn || a.index - b.index);
    const smallNet = small.netNgn;
    const largeNet = large.netNgn;
    if (left >= smallNet + largeNet) {
      paidByIndex.set(small.index, smallNet);
      paidByIndex.set(large.index, largeNet);
    } else if (left === smallNet) {
      paidByIndex.set(small.index, smallNet);
      paidByIndex.set(large.index, 0);
    } else if (left === largeNet) {
      paidByIndex.set(small.index, 0);
      paidByIndex.set(large.index, largeNet);
    } else if (left > largeNet) {
      // More than the customer share has left the till, so the staff share is inside that payment.
      paidByIndex.set(small.index, smallNet);
      paidByIndex.set(large.index, Math.min(largeNet, left - smallNet));
    } else if (left > smallNet) {
      // Between the two nets: treat it as part of the larger share, leave the staff amount intact.
      paidByIndex.set(small.index, 0);
      paidByIndex.set(large.index, left);
    } else {
      paidByIndex.set(small.index, left);
      paidByIndex.set(large.index, 0);
    }
  } else if (draft.length > 2) {
    const order = [...draft].sort((a, b) => a.netNgn - b.netNgn || a.index - b.index);
    for (const row of order) {
      const take = Math.min(row.netNgn, left);
      paidByIndex.set(row.index, take);
      left -= take;
    }
  } else {
    paidByIndex.set(draft[0].index, Math.min(draft[0].netNgn, left));
  }

  return draft.map((row) => {
    const paidToPayeeNgn = paidByIndex.get(row.index) || 0;
    const tillDueNgn = Math.max(0, row.netNgn - paidToPayeeNgn);
    const quoteBit =
      quoteCustomer && quoteCustomer !== row.payeeName ? ` · quotation customer ${quoteCustomer}` : '';
    const refBit = quotationRef ? ` · ${quotationRef}` : '';
    return {
      ...row,
      paidToPayeeNgn,
      tillDueNgn,
      cashierLabel: `${row.roleLabel} · ${row.payeeName} · ₦${row.netNgn.toLocaleString('en-NG')}${refBit}${quoteBit}`,
    };
  });
}

/**
 * One sentence so the cashier does not read two payees as one changing balance.
 * @param {Array<{ payeeName?: string, roleLabel?: string, netNgn?: number, tillDueNgn?: number, staffShare?: boolean }>|null|undefined} lines
 * @param {string} [quotationRef]
 */
export function refundCashierPayeeHeadline(lines, quotationRef = '') {
  const list = Array.isArray(lines) ? lines.filter((l) => roundRefundPayeeNgn(l?.netNgn) > 0) : [];
  if (list.length < 2) return '';
  const ref = String(quotationRef || list[0]?.quotationRef || '').trim();
  const bits = list.map((l) => {
    const due = roundRefundPayeeNgn(l.tillDueNgn);
    const net = roundRefundPayeeNgn(l.netNgn);
    const who = `${l.payeeName} (${String(l.roleLabel || '').toLowerCase()})`;
    if (due <= 0) return `${who} ₦${net.toLocaleString('en-NG')} already paid`;
    if (due !== net) {
      return `${who} ₦${net.toLocaleString('en-NG')}, till due ₦${due.toLocaleString('en-NG')}`;
    }
    return `${who} ₦${net.toLocaleString('en-NG')}`;
  });
  const where = ref ? ` on ${ref}` : '';
  return `Two payees${where}: ${bits.join('; ')}. Same quotation, different people — paying one does not change the other.`;
}

/**
 * After cash attribution, cap open tillDue so lines cannot exceed settlement till payable
 * (receipt credit / holds reduce till without being a payee cash payout).
 * @param {Array<object>|null|undefined} lines
 * @param {number} tillPayableNgn
 */
export function capRefundCashierLinesToTillPayable(lines, tillPayableNgn) {
  const list = Array.isArray(lines) ? lines : [];
  if (!list.length) return list;
  const cap = Math.max(0, roundRefundPayeeNgn(tillPayableNgn));
  const open = list
    .map((l, index) => ({ index, due: Math.max(0, roundRefundPayeeNgn(l?.tillDueNgn)) }))
    .filter((x) => x.due > 0);
  const sum = open.reduce((s, x) => s + x.due, 0);
  if (sum <= 0 || sum <= cap) return list;
  if (cap <= 0) {
    return list.map((l) => ({ ...l, tillDueNgn: 0 }));
  }
  // Prefer keeping the unpaid staff/customer slice intact when only one line is open.
  if (open.length === 1) {
    return list.map((l, i) => (i === open[0].index ? { ...l, tillDueNgn: cap } : { ...l, tillDueNgn: 0 }));
  }
  let left = cap;
  const dueByIndex = new Map();
  for (const row of open) {
    const take = Math.min(row.due, left);
    dueByIndex.set(row.index, take);
    left -= take;
  }
  return list.map((l, i) =>
    dueByIndex.has(i) ? { ...l, tillDueNgn: dueByIndex.get(i) } : { ...l, tillDueNgn: 0 }
  );
}

/**
 * Shrink a single payee's `netPayoutNgn` so the Pay-out desk matches till still owed after
 * credit apply (RF-KD-26-9636: show ₦751,480 not ₦959,380 after ₦207,900 credit).
 * Two or more payees are left alone — spreading one remainder across them makes the
 * staff ₦67,840 and the customer ₦250,000 look like one figure that changed.
 *
 * @param {Array<object>|null|undefined} splits
 * @param {number} tillPayableNgn
 * @returns {Array<object>}
 */
export function applyRefundSplitRemainingTillPayable(splits, tillPayableNgn) {
  const list = Array.isArray(splits) ? splits : [];
  if (!list.length) return list;
  const remaining = Math.max(0, Math.round(Number(tillPayableNgn) || 0));
  const nets = list.map((s) => refundSplitOwnNetNgn(s));
  const positive = nets.filter((n) => n > 0).length;
  if (positive > 1) return list;
  const sum = nets.reduce((a, b) => a + b, 0);
  if (sum <= 0 || remaining >= sum) return list;

  let allocated = 0;
  return list.map((s, i) => {
    const original = nets[i];
    const isLast = i === list.length - 1;
    const take = isLast
      ? Math.max(0, remaining - allocated)
      : Math.round((original / sum) * remaining);
    allocated += take;
    if (take === original) return s;
    return {
      ...s,
      netPayoutNgn: take,
      originalNetPayoutNgn: original,
      remainingTillPayableNgn: take,
    };
  });
}

/**
 * Write each payee's own till due onto the split. Does not give one payee a slice of the other's money.
 * @param {Array<object>} splits
 * @param {Array<{ index?: number, tillDueNgn?: number, netNgn?: number, payeeName?: string, cashierLabel?: string, roleLabel?: string }>} lines
 */
export function stampRefundPayeeTillDue(splits, lines) {
  const list = Array.isArray(splits) ? splits : [];
  const rows = Array.isArray(lines) ? lines : [];
  if (rows.length < 2 || !list.length) return list;
  return list.map((split, i) => {
    const label = refundSplitPayeeLabel(split);
    const line =
      (label && rows.find((l) => l.payeeName === label)) ||
      (rows.length === list.length ? rows[i] : null);
    if (!line) return split;
    return {
      ...split,
      payeeName: refundSplitPayeeLabel(split) || line.payeeName,
      payeeRoleLabel: line.roleLabel,
      cashierLabel: line.cashierLabel,
      originalNetPayoutNgn: line.netNgn,
      netPayoutNgn: line.tillDueNgn,
      remainingTillPayableNgn: line.tillDueNgn,
    };
  });
}

/**
 * @param {object} r
 * @returns {object}
 */
export function normalizeRefund(r) {
  const amountNgn = Number(r.amountNgn) || 0;
  const paidAmountNgn = Number(r.paidAmountNgn) || 0;
  const approvedAmountNgn = refundApprovedAmount({ ...r, amountNgn, paidAmountNgn });
  return {
    refundID: r.refundID,
    customerID: r.customerID ?? '',
    customer: r.customer ?? '',
    quotationRef: r.quotationRef ?? '',
    cuttingListRef: r.cuttingListRef ?? '',
    product: r.product ?? '—',
    reasonCategory: r.reasonCategory ?? '',
    reason: r.reason ?? '—',
    amountNgn,
    calculationLines: Array.isArray(r.calculationLines) ? r.calculationLines.map(normalizeLine) : [],
    suggestedLines: Array.isArray(r.suggestedLines) ? r.suggestedLines.map(normalizeLine) : [],
    previewSnapshot:
      r.previewSnapshot != null && typeof r.previewSnapshot === 'object' ? r.previewSnapshot : null,
    calculationNotes: r.calculationNotes ?? '',
    status:
      r.status === 'Paid' ||
      r.status === 'Rejected' ||
      r.status === 'Cancelled' ||
      r.status === 'Approved' ||
      r.status === 'Partially paid'
        ? r.status
        : 'Pending',
    requestedBy: r.requestedBy ?? '—',
    requestedAtISO: r.requestedAtISO ?? '',
    approvalDate: r.approvalDate ?? '',
    approvedBy: r.approvedBy ?? '',
    approvedAmountNgn,
    managerComments: r.managerComments ?? '',
    paidAmountNgn,
    paidAtISO: r.paidAtISO ?? '',
    paidBy: r.paidBy ?? '',
    paymentNote: r.paymentNote ?? '',
    payoutHistory: Array.isArray(r.payoutHistory) ? r.payoutHistory.map(normalizePayoutLine) : [],
    splitDistributions: Array.isArray(r.splitDistributions) ? r.splitDistributions : [],
    cashierPayoutLines: Array.isArray(r.cashierPayoutLines) ? r.cashierPayoutLines : [],
    creditAppliedNgn: Math.round(Number(r.creditAppliedNgn ?? r.credit_applied_ngn) || 0),
    settlementSummary:
      r.settlementSummary != null && typeof r.settlementSummary === 'object' ? r.settlementSummary : null,
    companyCutNgn: Math.round(Number(r.companyCutNgn ?? r?.settlementSummary?.companyCutNgn) || 0),
    outstandingAmountNgn: refundOutstandingAmount({
      ...r,
      amountNgn,
      paidAmountNgn,
      approvedAmountNgn,
    }),
    quotationRefundsBlockedAtISO:
      r.quotationRefundsBlockedAtISO ?? r.quotation_refunds_blocked_at_iso ?? null,
    quotationRefundsBlockedReason:
      r.quotationRefundsBlockedReason ?? r.quotation_refunds_blocked_reason ?? '',
    payoutHold: r.payoutHold === true || r.payoutHold === 1 || r.payout_hold === 1 || r.payout_hold === '1',
    payoutHoldReason: String(r.payoutHoldReason ?? r.payout_hold_reason ?? '').trim(),
  };
}

export function refundIsOnPayoutHold(r) {
  return r?.payoutHold === true || r?.payoutHold === 1 || r?.payout_hold === 1 || r?.payout_hold === '1';
}

export function refundPayoutHoldReason(r) {
  if (!refundIsOnPayoutHold(r)) return '';
  return String(r?.payoutHoldReason ?? r?.payout_hold_reason ?? '').trim();
}

export function isRefundPayable(r) {
  if (refundQuotationRefundsBlocked(r)) return false;
  const status = r?.status;
  if (status !== 'Approved' && status !== 'Partially paid') return false;
  if (refundIsOnPayoutHold(r)) return false;

  // Settlement till payable already excludes leftover-fund clears, open wallet, and uncleared holds.
  const tillFromSummary = r?.settlementSummary?.tillPayableNgn;
  if (tillFromSummary != null && Number.isFinite(Number(tillFromSummary))) {
    const till = Math.round(Number(tillFromSummary) || 0);
    if (till <= 0) return false;
    const outstanding = refundCreditAdjustedOutstandingNgn(r);
    if (outstanding > 0) return true;
    // Stale credit counter (e.g. leftover-clear counted as apply) can zero outstanding while
    // till + cashier lines still show an unpaid staff/customer slice — keep it on the desk.
    const lineDue = (Array.isArray(r?.cashierPayoutLines) ? r.cashierPayoutLines : []).reduce(
      (sum, line) => sum + Math.max(0, Math.round(Number(line?.tillDueNgn) || 0)),
      0
    );
    return lineDue > 0;
  }

  const approved = refundApprovedAmount(r);
  const paid = Math.round(Number(r?.paidAmountNgn ?? r?.paid_amount_ngn) || 0);
  const creditApplied = Math.round(Number(r?.creditAppliedNgn ?? r?.credit_applied_ngn) || 0);
  if (approved > 0 && Math.max(paid, creditApplied) >= approved) return false;
  if (Math.round(Number(r?.walletOpenNgn) || 0) > 0) return false;
  return refundOutstandingAmount(r) > 0;
}

export function loadRefunds() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.map(normalizeRefund);
      }
    }
  } catch {
    /* ignore */
  }
  return [];
}

export function saveRefunds(list) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list.map(normalizeRefund)));
  } catch {
    /* ignore */
  }
}

export function approvedRefundsAwaitingPayment(list) {
  return (list ?? []).filter(isRefundPayable);
}
