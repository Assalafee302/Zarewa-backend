/**
 * Company cut on refund allocations paid to associated / claiming staff (not the quote customer).
 * Gross allocation stays on the refund for headroom; net after company cut (and any uncleared
 * receipt offset) is what Finance pays out.
 */

export const REFUND_STAFF_ALLOCATION_DEDUCTION_RATE = 0.2;

/** Default percent for Settings / org policy (Admin/MD). */
export const REFUND_STAFF_ALLOCATION_DEDUCTION_PCT_DEFAULT = 20;

export function roundRefundStaffMoney(value) {
  return Math.round(Number(value) || 0);
}

/**
 * Normalize Admin/MD percent (0–99) or legacy rate (0–1) into a deduction rate.
 * 0 disables the company cut. 100 is rejected (use 99 max).
 */
export function normalizeRefundStaffAllocationDeductionRate(raw) {
  if (raw == null || raw === '') return REFUND_STAFF_ALLOCATION_DEDUCTION_RATE;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return REFUND_STAFF_ALLOCATION_DEDUCTION_RATE;
  if (n === 0) return 0;
  if (n > 0 && n < 1) return n;
  if (n >= 1 && n <= 99) return n / 100;
  return REFUND_STAFF_ALLOCATION_DEDUCTION_RATE;
}

export function refundStaffAllocationDeductionPctFromRate(rate) {
  const r = normalizeRefundStaffAllocationDeductionRate(rate);
  return Math.round(r * 100);
}

/**
 * True when this split is paid to associated staff or a claiming-staff / other payee —
 * not the quotation customer themselves.
 */
export function refundSplitTakesStaffDeduction(split, quoteCustomerId = '') {
  const kind = String(split?.recipientKind || split?.payoutAccount?.partyKind || '')
    .trim()
    .toLowerCase();
  if (kind === 'associated_staff' || kind === 'staff') return true;
  const staffId = String(split?.recipientAssociatedStaffID || '').trim();
  if (staffId) return true;
  const recipientCustomerId = String(split?.recipientCustomerID || '').trim();
  const quoteId = String(quoteCustomerId || '').trim();
  if (!recipientCustomerId) return false;
  if (quoteId && recipientCustomerId === quoteId) return false;
  return true;
}

/**
 * @param {number} grossNgn
 * @param {number} [rate]
 * @returns {{ grossNgn: number, deductionRate: number, companyDeductionNgn: number, netPayoutNgn: number }}
 */
export function refundStaffAllocationDeductionAmounts(
  grossNgn,
  rate = REFUND_STAFF_ALLOCATION_DEDUCTION_RATE
) {
  const gross = Math.max(0, roundRefundStaffMoney(grossNgn));
  const deductionRate = normalizeRefundStaffAllocationDeductionRate(rate);
  if (gross <= 0 || deductionRate <= 0) {
    return {
      grossNgn: gross,
      deductionRate: 0,
      companyDeductionNgn: 0,
      netPayoutNgn: gross,
    };
  }
  const companyDeductionNgn = roundRefundStaffMoney(gross * deductionRate);
  const netPayoutNgn = Math.max(0, gross - companyDeductionNgn);
  return {
    grossNgn: gross,
    deductionRate,
    companyDeductionNgn,
    netPayoutNgn,
  };
}

/**
 * Enrich a split row with deduction + optional uncleared-receipt offset.
 * Amount on the split remains the gross allocation.
 *
 * @param {object} split
 * @param {string} [quoteCustomerId]
 * @param {{
 *   deductionRate?: number,
 *   unclearedReceiptHoldNgn?: number,
 * }} [opts]
 */
export function applyRefundStaffAllocationDeduction(split, quoteCustomerId = '', opts = {}) {
  const amountNgn = roundRefundStaffMoney(split?.amountNgn ?? split?.amount_ngn);
  const deductionRate = normalizeRefundStaffAllocationDeductionRate(
    opts.deductionRate ?? split?.deductionRate ?? REFUND_STAFF_ALLOCATION_DEDUCTION_RATE
  );
  const unclearedHoldNgn = Math.max(0, roundRefundStaffMoney(opts.unclearedReceiptHoldNgn));
  const base = {
    ...split,
    amountNgn,
  };
  if (!refundSplitTakesStaffDeduction(base, quoteCustomerId)) {
    return {
      ...base,
      grossNgn: amountNgn,
      companyDeductionNgn: 0,
      netPayoutNgn: amountNgn,
      deductionRate: 0,
      unclearedReceiptHoldNgn: 0,
      unclearedReceiptOffsetNgn: 0,
      payoutHeldForUnclearedReceipts: false,
    };
  }
  const calc = refundStaffAllocationDeductionAmounts(amountNgn, deductionRate);
  const afterCut = calc.netPayoutNgn;
  const unclearedReceiptOffsetNgn = Math.min(afterCut, unclearedHoldNgn);
  const netPayoutNgn = Math.max(0, afterCut - unclearedReceiptOffsetNgn);
  return {
    ...base,
    grossNgn: calc.grossNgn,
    companyDeductionNgn: calc.companyDeductionNgn,
    netPayoutNgn,
    deductionRate: calc.deductionRate,
    unclearedReceiptHoldNgn: unclearedHoldNgn,
    unclearedReceiptOffsetNgn,
    payoutHeldForUnclearedReceipts: unclearedHoldNgn > 0 && netPayoutNgn <= 0 && afterCut > 0,
  };
}

/**
 * @param {Array<object>} splits
 * @param {string} [quoteCustomerId]
 * @param {{
 *   deductionRate?: number,
 *   unclearedByCustomerId?: Map<string, number> | Record<string, number>,
 * }} [opts]
 */
export function applyRefundStaffAllocationDeductions(splits, quoteCustomerId = '', opts = {}) {
  const rate = opts.deductionRate;
  const byCust = opts.unclearedByCustomerId;
  const getHold = (customerId) => {
    const id = String(customerId || '').trim();
    if (!id || !byCust) return 0;
    if (byCust instanceof Map) return roundRefundStaffMoney(byCust.get(id));
    return roundRefundStaffMoney(byCust[id]);
  };
  return (Array.isArray(splits) ? splits : []).map((s) =>
    applyRefundStaffAllocationDeduction(s, quoteCustomerId, {
      deductionRate: rate,
      unclearedReceiptHoldNgn: getHold(s?.recipientCustomerID),
    })
  );
}

export function sumRefundStaffCompanyDeductionNgn(splits) {
  return (Array.isArray(splits) ? splits : []).reduce(
    (sum, s) => sum + roundRefundStaffMoney(s?.companyDeductionNgn),
    0
  );
}

export function sumRefundStaffUnclearedOffsetNgn(splits) {
  return (Array.isArray(splits) ? splits : []).reduce(
    (sum, s) => sum + roundRefundStaffMoney(s?.unclearedReceiptOffsetNgn),
    0
  );
}

export function sumRefundStaffNetPayoutNgn(splits) {
  return (Array.isArray(splits) ? splits : []).reduce((sum, s) => {
    const net = s?.netPayoutNgn;
    if (net != null && Number.isFinite(Number(net))) {
      return sum + roundRefundStaffMoney(net);
    }
    return sum + roundRefundStaffMoney(s?.amountNgn);
  }, 0);
}
