/**
 * Company cut on refund allocations paid to associated / claiming staff (not the quote customer).
 * Two different rates apply depending on who is being paid:
 *   - Company / claiming staff (an HR login claiming via their linked sales-customer account,
 *     recipientKind 'customer' with an id different from the quote's own customer) — 20%.
 *   - Associated staff — drivers (Transport) and installers/roofers (Installation),
 *     recipientKind 'associated_staff' — 3%.
 *   - The quote customer themselves — 0%, no cut at all.
 * Gross allocation stays on the refund for headroom; net after company cut is what Finance pays out.
 * Uncleared receipt float is informational only — it may block payout until cleared but is never
 * auto-settled into paid_amount at approval.
 */

/** Company / claiming staff — an HR login claiming a refund via their own customer account. */
export const REFUND_STAFF_ALLOCATION_DEDUCTION_RATE = 0.2;

/** Default percent for Settings / org policy (Admin/MD) — company / claiming staff. */
export const REFUND_STAFF_ALLOCATION_DEDUCTION_PCT_DEFAULT = 20;

/** Associated staff — drivers (Transport) and installers/roofers (Installation). */
export const REFUND_ASSOCIATED_STAFF_DEDUCTION_RATE = 0.03;

/** Default percent for Settings / org policy (Admin/MD) — associated staff (driver/installer). */
export const REFUND_ASSOCIATED_STAFF_DEDUCTION_PCT_DEFAULT = 3;

export function roundRefundStaffMoney(value) {
  return Math.round(Number(value) || 0);
}

/**
 * Normalize Admin/MD percent (0–99) or legacy rate (0–1) into a deduction rate.
 * 0 disables the company cut. 100 is rejected (use 99 max).
 * @param {number | string | null | undefined} raw
 * @param {number} [fallback] used when raw is missing/invalid — pass the category's own default
 *   (REFUND_STAFF_ALLOCATION_DEDUCTION_RATE for company/claiming staff,
 *   REFUND_ASSOCIATED_STAFF_DEDUCTION_RATE for drivers/installers) rather than relying on this
 *   function's own default, which only matches the company/claiming-staff category.
 */
export function normalizeRefundStaffAllocationDeductionRate(
  raw,
  fallback = REFUND_STAFF_ALLOCATION_DEDUCTION_RATE
) {
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return fallback;
  if (n === 0) return 0;
  if (n > 0 && n < 1) return n;
  if (n >= 1 && n <= 99) return n / 100;
  return fallback;
}

export function refundStaffAllocationDeductionPctFromRate(
  rate,
  fallback = REFUND_STAFF_ALLOCATION_DEDUCTION_RATE
) {
  const r = normalizeRefundStaffAllocationDeductionRate(rate, fallback);
  return Math.round(r * 100);
}

/** True when this split is a driver/installer (associated staff) rather than claiming staff. */
export function refundSplitIsAssociatedStaff(split) {
  const kind = String(split?.recipientKind || split?.payoutAccount?.partyKind || '')
    .trim()
    .toLowerCase();
  if (kind === 'associated_staff' || kind === 'staff') return true;
  const staffId = String(split?.recipientAssociatedStaffID || '').trim();
  const customerId = String(split?.recipientCustomerID || '').trim();
  return Boolean(staffId) && !customerId;
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
 * Enrich a split row with deduction + optional uncleared-receipt hold (informational).
 * Amount on the split remains the gross allocation.
 * Admin/MD may set companyCutWaived to skip the company % (uncleared hold still applies
 * for cashiers; admin may override the hold at payout). Quote-customer lines skip the
 * company cut but still take the uncleared-receipt hold.
 *
 * @param {object} split
 * @param {string} [quoteCustomerId]
 * @param {{
 *   deductionRate?: number,
 *   associatedStaffDeductionRate?: number,
 *   claimingStaffDeductionRate?: number,
 *   unclearedReceiptHoldNgn?: number,
 *   honorCompanyCutWaiver?: boolean,
 *   overpaymentOnly?: boolean,
 * }} [opts] `deductionRate` forces one exact rate regardless of category (used by callers that
 *   already resolved the right rate, and by tests). Otherwise the rate is picked by category:
 *   `associatedStaffDeductionRate` for drivers/installers, `claimingStaffDeductionRate` for
 *   company/claiming staff — each falling back to that category's own default.
 */
export function applyRefundStaffAllocationDeduction(split, quoteCustomerId = '', opts = {}) {
  const amountNgn = roundRefundStaffMoney(split?.amountNgn ?? split?.amount_ngn);
  const honorWaiver = opts.honorCompanyCutWaiver !== false;
  const waiverRequested = Boolean(
    split?.companyCutWaived === true ||
      split?.company_cut_waived === true ||
      split?.waiveCompanyCut === true
  );
  const companyCutWaived = honorWaiver && waiverRequested;
  const waiverNote = String(
    split?.companyCutWaiverNote ?? split?.company_cut_waiver_note ?? ''
  ).trim();
  const isAssociatedStaffKind = refundSplitIsAssociatedStaff(split);
  const categoryDefaultRate = isAssociatedStaffKind
    ? REFUND_ASSOCIATED_STAFF_DEDUCTION_RATE
    : REFUND_STAFF_ALLOCATION_DEDUCTION_RATE;
  const categoryOptsRate = isAssociatedStaffKind
    ? opts.associatedStaffDeductionRate
    : opts.claimingStaffDeductionRate;
  const deductionRate = companyCutWaived
    ? 0
    : normalizeRefundStaffAllocationDeductionRate(
        opts.deductionRate ?? categoryOptsRate ?? split?.deductionRate ?? categoryDefaultRate,
        categoryDefaultRate
      );
  const unclearedHoldNgn = Math.max(0, roundRefundStaffMoney(opts.unclearedReceiptHoldNgn));
  const overpaymentOnly = opts.overpaymentOnly === true;
  const base = {
    ...split,
    amountNgn,
    companyCutWaived,
    companyCutWaiverNote: companyCutWaived ? waiverNote : '',
  };
  if (!refundSplitTakesStaffDeduction(base, quoteCustomerId)) {
    return {
      ...base,
      grossNgn: amountNgn,
      companyDeductionNgn: 0,
      netPayoutNgn: amountNgn,
      deductionRate: 0,
      companyCutWaived: false,
      companyCutWaiverNote: '',
      unclearedReceiptHoldNgn: unclearedHoldNgn,
      unclearedReceiptOffsetNgn: 0,
      payoutHeldForUnclearedReceipts: unclearedHoldNgn > 0 && amountNgn > 0,
    };
  }
  const calc = refundStaffAllocationDeductionAmounts(amountNgn, deductionRate);
  const netPayoutNgn = calc.netPayoutNgn;
  return {
    ...base,
    grossNgn: calc.grossNgn,
    companyDeductionNgn: calc.companyDeductionNgn,
    netPayoutNgn,
    deductionRate: calc.deductionRate,
    unclearedReceiptHoldNgn: unclearedHoldNgn,
    unclearedReceiptOffsetNgn: 0,
    payoutHeldForUnclearedReceipts: unclearedHoldNgn > 0 && netPayoutNgn > 0,
    overpaymentCashierReferralAvailable:
      overpaymentOnly && unclearedHoldNgn > 0 && netPayoutNgn > 0,
  };
}

/**
 * @param {Array<object>} splits
 * @param {string} [quoteCustomerId]
 * @param {{
 *   deductionRate?: number,
 *   associatedStaffDeductionRate?: number,
 *   claimingStaffDeductionRate?: number,
 *   unclearedByCustomerId?: Map<string, number> | Record<string, number>,
 *   honorCompanyCutWaiver?: boolean,
 *   overpaymentOnly?: boolean,
 * }} [opts]
 */
export function applyRefundStaffAllocationDeductions(splits, quoteCustomerId = '', opts = {}) {
  const byCust = opts.unclearedByCustomerId;
  const overpaymentOnly = opts.overpaymentOnly === true;
  const getHold = (customerId) => {
    const id = String(customerId || '').trim();
    if (!id || !byCust) return 0;
    if (byCust instanceof Map) return roundRefundStaffMoney(byCust.get(id));
    return roundRefundStaffMoney(byCust[id]);
  };
  return (Array.isArray(splits) ? splits : []).map((s) =>
    applyRefundStaffAllocationDeduction(s, quoteCustomerId, {
      deductionRate: opts.deductionRate,
      associatedStaffDeductionRate: opts.associatedStaffDeductionRate,
      claimingStaffDeductionRate: opts.claimingStaffDeductionRate,
      unclearedReceiptHoldNgn: getHold(s?.recipientCustomerID),
      honorCompanyCutWaiver: opts.honorCompanyCutWaiver,
      overpaymentOnly,
    })
  );
}

export function sumRefundStaffCompanyDeductionNgn(splits) {
  return (Array.isArray(splits) ? splits : []).reduce(
    (sum, s) => sum + roundRefundStaffMoney(s?.companyDeductionNgn),
    0
  );
}

export function sumRefundStaffUnclearedHoldNgn(splits) {
  return (Array.isArray(splits) ? splits : []).reduce(
    (sum, s) => sum + roundRefundStaffMoney(s?.unclearedReceiptHoldNgn),
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
