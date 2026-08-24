/**
 * Company cut on refund allocations paid to associated / claiming staff (not the quote customer).
 * Gross allocation stays on the refund for headroom; net (80%) is what Finance pays out.
 */

export const REFUND_STAFF_ALLOCATION_DEDUCTION_RATE = 0.2;

export function roundRefundStaffMoney(value) {
  return Math.round(Number(value) || 0);
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
  const r = Number(rate);
  const deductionRate = Number.isFinite(r) && r > 0 && r < 1 ? r : 0;
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
 * Enrich a split row with deduction fields. Amount on the split remains the gross allocation.
 */
export function applyRefundStaffAllocationDeduction(split, quoteCustomerId = '') {
  const amountNgn = roundRefundStaffMoney(split?.amountNgn ?? split?.amount_ngn);
  const base = {
    ...split,
    amountNgn,
  };
  if (!refundSplitTakesStaffDeduction(base, quoteCustomerId)) {
    return {
      ...base,
      companyDeductionNgn: 0,
      netPayoutNgn: amountNgn,
      deductionRate: 0,
    };
  }
  const calc = refundStaffAllocationDeductionAmounts(amountNgn);
  return {
    ...base,
    companyDeductionNgn: calc.companyDeductionNgn,
    netPayoutNgn: calc.netPayoutNgn,
    deductionRate: calc.deductionRate,
  };
}

/**
 * @param {Array<object>} splits
 * @param {string} [quoteCustomerId]
 */
export function applyRefundStaffAllocationDeductions(splits, quoteCustomerId = '') {
  return (Array.isArray(splits) ? splits : []).map((s) =>
    applyRefundStaffAllocationDeduction(s, quoteCustomerId)
  );
}

export function sumRefundStaffCompanyDeductionNgn(splits) {
  return (Array.isArray(splits) ? splits : []).reduce(
    (sum, s) => sum + roundRefundStaffMoney(s?.companyDeductionNgn),
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
