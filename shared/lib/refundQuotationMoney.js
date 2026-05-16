/**
 * Refund headroom on a quotation (this quote's cash only — not other customer balance).
 *
 * - Overpayment is cash received above the quote total (payment − quotation).
 * - Other categories (unproduced metreage, substitution, services, etc.) are independent reasons
 *   with their own calculated amounts from the quote / production facts.
 * - Total refund cannot exceed cash received on this quotation minus refunds already on file.
 */

export function roundRefundMoney(value) {
  return Math.round(Number(value) || 0);
}

/**
 * Hard ceiling: total cash that can still be returned on this quotation.
 * @param {{ cashInNgn: number, quoteTotalNgn?: number, totalRefundedNgn: number }} p
 * @returns {number}
 */
export function quotationRefundHardCapNgn({ cashInNgn, totalRefundedNgn }) {
  const cashIn = roundRefundMoney(cashInNgn);
  const refunded = roundRefundMoney(totalRefundedNgn);
  if (cashIn <= 0) return 0;
  return Math.max(0, cashIn - refunded);
}

/**
 * @deprecated Use {@link quotationRefundHardCapNgn} for total cap; {@link quotationRemainingRefundableNgn} when preview lines exist.
 */
export function quotationRefundHeadroomNgn({ cashInNgn, quoteTotalNgn, totalRefundedNgn, suggestedLines }) {
  const cashIn = roundRefundMoney(cashInNgn);
  const refunded = roundRefundMoney(totalRefundedNgn);
  const hardCap = quotationRefundHardCapNgn({ cashInNgn: cashIn, totalRefundedNgn: refunded });
  if (Array.isArray(suggestedLines) && suggestedLines.length > 0) {
    return quotationRemainingRefundableNgn({
      cashInNgn: cashIn,
      quoteTotalNgn,
      totalRefundedNgn: refunded,
      suggestedLines,
    });
  }
  return hardCap;
}

/**
 * Excess cash on this quotation above the quote total (Overpayment category limit).
 * @param {{ cashInNgn: number, quoteTotalNgn: number }} p
 * @returns {number}
 */
export function quotationOverpaymentExcessNgn({ cashInNgn, quoteTotalNgn }) {
  const cashIn = roundRefundMoney(cashInNgn);
  const quoteTotal = roundRefundMoney(quoteTotalNgn);
  if (quoteTotal <= 0 || cashIn <= quoteTotal) return 0;
  return cashIn - quoteTotal;
}

/**
 * Sum of non-overpayment suggested/entered lines (independent category entitlements).
 * @param {Array<{ category?: string, amountNgn?: number }>} suggestedLines
 */
export function quotationIndependentRefundLinesSumNgn(suggestedLines) {
  const lines = Array.isArray(suggestedLines) ? suggestedLines : [];
  return lines.reduce((sum, line) => {
    if (String(line?.category || '').trim() === 'Overpayment') return sum;
    return sum + roundRefundMoney(line?.amountNgn);
  }, 0);
}

/**
 * Remaining refundable for UI / preview: overpayment excess + independent category amounts, capped by cash hard cap.
 * @param {{
 *   cashInNgn: number,
 *   quoteTotalNgn: number,
 *   totalRefundedNgn: number,
 *   suggestedLines?: Array<{ category?: string, amountNgn?: number }>,
 * }} p
 */
export function quotationRemainingRefundableNgn({
  cashInNgn,
  quoteTotalNgn,
  totalRefundedNgn,
  suggestedLines,
}) {
  const hardCap = quotationRefundHardCapNgn({ cashInNgn, totalRefundedNgn });
  const overpay = quotationOverpaymentExcessNgn({ cashInNgn, quoteTotalNgn });
  const independent = quotationIndependentRefundLinesSumNgn(suggestedLines);
  return Math.min(hardCap, overpay + independent);
}

/**
 * @param {{
 *   cashInNgn: number,
 *   quoteTotalNgn: number,
 *   totalRefundedNgn: number,
 *   calculationLines: Array<{ category?: string, amountNgn?: number }>,
 * }} p
 * @returns {{ ok: true, hardCapNgn: number, remainingRefundableNgn: number } | { ok: false, error: string }}
 */
export function validateRefundCalculationLinesNgn({
  cashInNgn,
  quoteTotalNgn,
  totalRefundedNgn,
  calculationLines,
}) {
  const lines = Array.isArray(calculationLines) ? calculationLines : [];
  const cashIn = roundRefundMoney(cashInNgn);
  const quoteTotal = roundRefundMoney(quoteTotalNgn);
  const refunded = roundRefundMoney(totalRefundedNgn);
  const hardCap = quotationRefundHardCapNgn({ cashInNgn: cashIn, totalRefundedNgn: refunded });
  const overpayMax = quotationOverpaymentExcessNgn({ cashInNgn: cashIn, quoteTotalNgn: quoteTotal });

  let sum = 0;
  for (const line of lines) {
    const amt = roundRefundMoney(line.amountNgn);
    if (amt <= 0) continue;
    const cat = String(line.category || '').trim();
    if (cat === 'Overpayment' && overpayMax >= 0 && amt > overpayMax) {
      return {
        ok: false,
        error: `Overpayment refund cannot exceed ₦${overpayMax.toLocaleString('en-NG')} (payment received minus quote total on this quotation).`,
      };
    }
    sum += amt;
  }

  if (sum > hardCap) {
    return {
      ok: false,
      error: `Included refund lines total ₦${sum.toLocaleString('en-NG')} exceeds cash received on this quotation after prior refunds (max ₦${hardCap.toLocaleString('en-NG')}).`,
    };
  }

  return {
    ok: true,
    hardCapNgn: hardCap,
    remainingRefundableNgn: quotationRemainingRefundableNgn({
      cashInNgn: cashIn,
      quoteTotalNgn: quoteTotal,
      totalRefundedNgn: refunded,
      suggestedLines: lines,
    }),
    overpaymentMaxNgn: overpayMax,
  };
}

/**
 * Economic cash on one quotation for refund caps — avoids counting OVERPAY_ADVANCE twice when
 * staff post again on an already-settled quote (companion split overpay is already in receipt cash).
 */
export function quotationActualCashInNgn({
  receiptCashNgn,
  advanceAppliedNgn = 0,
  netOverpayLedgerNgn = 0,
  companionOverpayOnQuoteNgn = 0,
  settledQuoteFullOverpayNgn = 0,
}) {
  const receiptCash = roundRefundMoney(receiptCashNgn);
  const advance = roundRefundMoney(advanceAppliedNgn);
  const companion = Math.max(0, roundRefundMoney(companionOverpayOnQuoteNgn));
  const netOverpay = Math.max(0, roundRefundMoney(netOverpayLedgerNgn));
  const settledFull = Math.max(0, roundRefundMoney(settledQuoteFullOverpayNgn));

  let standaloneOverpay = Math.max(0, netOverpay - companion);
  if (receiptCash > 0 && settledFull > 0) {
    standaloneOverpay = Math.max(0, standaloneOverpay - settledFull);
  }

  return roundRefundMoney(receiptCash + advance + standaloneOverpay);
}
