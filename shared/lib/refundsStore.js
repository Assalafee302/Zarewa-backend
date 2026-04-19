/**
 * Refund requests — shared between Sales (create / approve) and Finance (pay out).
 * Live data comes from workspace snapshot; localStorage is legacy-only if present.
 */

const STORAGE_KEY = 'zarewa.sales.refunds';

/** @typedef {'Pending'|'Approved'|'Rejected'|'Paid'} RefundStatus */

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
  if (r?.status === 'Approved' || r?.status === 'Paid') return requested;
  return 0;
}

export function refundOutstandingAmount(r) {
  const paid = Number(r?.paidAmountNgn) || 0;
  return Math.max(0, refundApprovedAmount(r) - paid);
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
    status: r.status === 'Paid' || r.status === 'Rejected' || r.status === 'Approved' ? r.status : 'Pending',
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
    outstandingAmountNgn: Math.max(0, approvedAmountNgn - paidAmountNgn),
  };
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
  return (list ?? []).filter((r) => r.status === 'Approved' && refundOutstandingAmount(r) > 0);
}
