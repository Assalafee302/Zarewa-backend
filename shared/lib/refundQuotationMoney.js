/**
 * Refund headroom on a quotation (this quote's cash only — not other customer balance).
 *
 * - Overpayment is cash received above the quote total (payment − quotation).
 * - Other categories (unproduced metreage, substitution, services, etc.) are independent reasons
 *   with their own calculated amounts from the quote / production facts.
 * - Total refund cannot exceed cash received on this quotation minus refunds already on file.
 */

import { REFUND_DERIVED_CAP_CATEGORIES, mergeRefundCategoryCapsNgn } from './refundCategoryDerivedCaps.js';

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

function refundCalculationLinesFromRecord(refund) {
  if (Array.isArray(refund?.calculationLines)) return refund.calculationLines;
  const raw = refund?.calculation_lines_json ?? refund?.calculationLinesJson;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function refundReasonLooksLikeOverpayment(refund) {
  const raw = refund?.reasonCategory ?? refund?.reason_category;
  const tokens = [];
  if (Array.isArray(raw)) {
    for (const c of raw) tokens.push(String(c || ''));
  } else {
    const s = String(raw || '').trim();
    if (s.startsWith('[')) {
      try {
        const parsed = JSON.parse(s);
        if (Array.isArray(parsed)) {
          for (const c of parsed) tokens.push(String(c || ''));
        } else {
          tokens.push(s);
        }
      } catch {
        tokens.push(s);
      }
    } else if (s) {
      tokens.push(s);
    }
  }
  return tokens.some((c) => c.toLowerCase().includes('overpay'));
}

/**
 * How much overpayment this refund has already taken (paid, applied as credit, or reserved).
 * Rejected/cancelled do not consume.
 */
export function overpaymentReservedOnRefund(refund) {
  const status = String(refund?.status || '').trim().toLowerCase();
  if (status === 'rejected' || status === 'cancelled') return 0;
  const lines = refundCalculationLinesFromRecord(refund);
  const overpayFromLines = roundRefundMoney(sumRefundCalculationLinesByCategoryNgn(lines).Overpayment);
  const isOverpay = overpayFromLines > 0 || refundReasonLooksLikeOverpayment(refund);
  if (!isOverpay) return 0;
  const requested = roundRefundMoney(refund?.amountNgn ?? refund?.amount_ngn);
  const paid = roundRefundMoney(refund?.paidAmountNgn ?? refund?.paid_amount_ngn);
  const credit = roundRefundMoney(refund?.creditAppliedNgn ?? refund?.credit_applied_ngn);
  const economic = overpayFromLines > 0 ? overpayFromLines : requested;
  if (paid > 0 || status === 'paid') {
    return Math.min(economic, Math.max(paid, credit));
  }
  return economic;
}

export function overpaymentAlreadyRefundedNgn(refunds, excludeRefundId = null) {
  const exclude = String(excludeRefundId || '').trim();
  return (Array.isArray(refunds) ? refunds : []).reduce((sum, r) => {
    const id = String(r?.refundID || r?.refund_id || '').trim();
    if (exclude && id === exclude) return sum;
    return sum + overpaymentReservedOnRefund(r);
  }, 0);
}

/**
 * Overpayment still available after prior overpayment refunds and leftover credit applied to another quote.
 */
export function quotationOverpaymentResidualNgn({
  cashInNgn,
  quoteTotalNgn,
  overpaymentAlreadyRefundedNgn = 0,
  creditAppliedOutNgn = 0,
} = {}) {
  const excess = quotationOverpaymentExcessNgn({ cashInNgn, quoteTotalNgn });
  return Math.max(
    0,
    excess - roundRefundMoney(overpaymentAlreadyRefundedNgn) - roundRefundMoney(creditAppliedOutNgn)
  );
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
 * Sum included refund line amounts per canonical category (expands bundled appliesToCategories).
 * @param {Array<{ category?: string, amountNgn?: number, include?: boolean, appliesToCategories?: string[] }>} calculationLines
 * @returns {Record<string, number>}
 */
export function sumRefundCalculationLinesByCategoryNgn(calculationLines) {
  /** @type {Record<string, number>} */
  const sums = {};
  for (const line of calculationLines || []) {
    if (line?.include === false) continue;
    const amt = roundRefundMoney(line.amountNgn);
    if (amt <= 0) continue;
    const multi = line.appliesToCategories;
    const cats =
      Array.isArray(multi) && multi.length
        ? multi.map((c) => String(c || '').trim()).filter(Boolean)
        : [String(line.category || '').trim()].filter(Boolean);
    for (const cat of cats) {
      sums[cat] = (sums[cat] || 0) + amt;
    }
  }
  return sums;
}

/**
 * Per-category ceilings from preview suggested lines (manual edits may reduce, not increase).
 * @param {Array<{ category?: string, amountNgn?: number, appliesToCategories?: string[] }>} suggestedLines
 * @returns {Record<string, number>}
 */
export function buildRefundCategorySuggestedMaxNgn(suggestedLines) {
  return sumRefundCalculationLinesByCategoryNgn(
    (suggestedLines || []).map((line) => ({ ...line, include: true }))
  );
}

/**
 * @param {{
 *   calculationLines: Array<{ category?: string, amountNgn?: number, include?: boolean, appliesToCategories?: string[] }>,
 *   categorySuggestedMaxNgn?: Record<string, number>,
 *   derivedCategoryMaxNgn?: Record<string, number>,
 *   toleranceNgn?: number,
 * }} p
 */
export function validateRefundCategorySuggestedCapsNgn({
  calculationLines,
  categorySuggestedMaxNgn,
  derivedCategoryMaxNgn,
  toleranceNgn = 1,
}) {
  const caps = mergeRefundCategoryCapsNgn(categorySuggestedMaxNgn, derivedCategoryMaxNgn);
  const sums = sumRefundCalculationLinesByCategoryNgn(calculationLines);
  for (const [cat, sum] of Object.entries(sums)) {
    const cap = roundRefundMoney(caps[cat]);
    if (cap <= 0) {
      if (REFUND_DERIVED_CAP_CATEGORIES.has(cat) && sum > toleranceNgn) {
        return {
          ok: false,
          error: `${cat} refund (₦${sum.toLocaleString(
            'en-NG'
          )}) cannot be approved without a system-derived cap — refresh refund preview or recalculate quotation integrity.`,
          category: cat,
          sumNgn: sum,
          maxNgn: 0,
        };
      }
      continue;
    }
    if (sum > cap + toleranceNgn) {
      return {
        ok: false,
        error: `${cat} refund (₦${sum.toLocaleString(
          'en-NG'
        )}) cannot exceed the system-calculated amount for this category (₦${cap.toLocaleString(
          'en-NG'
        )}). Lower line amounts — manual adjustment may reduce, not increase, the preview figure.`,
        category: cat,
        sumNgn: sum,
        maxNgn: cap,
      };
    }
  }
  return { ok: true };
}

/**
 * Overpayment + Order cancellation on one request double-count cash received.
 * @param {Array<{ category?: string, amountNgn?: number, include?: boolean, appliesToCategories?: string[] }>} calculationLines
 */
export function validateRefundSameRequestOverlapCategoriesNgn(calculationLines) {
  const sums = sumRefundCalculationLinesByCategoryNgn(calculationLines);
  const hasOverpay = (sums.Overpayment || 0) > 0;
  const hasCancel = (sums['Order cancellation'] || 0) > 0;
  if (hasOverpay && hasCancel) {
    return {
      ok: false,
      error:
        'Overpayment and Order cancellation cannot appear on the same refund request — they double-count the same cash. Use one category or separate refund requests.',
    };
  }
  return { ok: true };
}

/**
 * Remaining refundable for UI / preview: sum of live suggested (or entered) lines,
 * capped by cash still on this quotation after prior refunds.
 *
 * Never re-add full historical overpayment excess when overpayment is not on the
 * suggested lines (e.g. already hard-blocked after a paid refund) — that
 * double-counted headroom and made remaining look like prior refunds never happened.
 *
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
  const lines = Array.isArray(suggestedLines) ? suggestedLines : [];
  if (lines.length > 0) {
    const suggestedSum = lines.reduce(
      (sum, line) => sum + roundRefundMoney(line?.amountNgn),
      0
    );
    return Math.min(hardCap, Math.max(0, suggestedSum));
  }
  // No live lines: residual overpayment only (after cash already refunded), not full excess.
  const overpay = quotationOverpaymentExcessNgn({ cashInNgn, quoteTotalNgn });
  const residualOverpay = Math.max(0, overpay - roundRefundMoney(totalRefundedNgn));
  return Math.min(hardCap, residualOverpay);
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
  categorySuggestedMaxNgn,
  derivedCategoryMaxNgn,
  overpaymentAlreadyRefundedNgn = 0,
  creditAppliedOutNgn = 0,
  toleranceNgn = 1,
}) {
  const lines = Array.isArray(calculationLines) ? calculationLines : [];
  const cashIn = roundRefundMoney(cashInNgn);
  const quoteTotal = roundRefundMoney(quoteTotalNgn);
  const refunded = roundRefundMoney(totalRefundedNgn);
  const hardCap = quotationRefundHardCapNgn({ cashInNgn: cashIn, totalRefundedNgn: refunded });
  const overpayMax = quotationOverpaymentResidualNgn({
    cashInNgn: cashIn,
    quoteTotalNgn: quoteTotal,
    overpaymentAlreadyRefundedNgn,
    creditAppliedOutNgn,
  });

  const overlapCheck = validateRefundSameRequestOverlapCategoriesNgn(lines);
  if (!overlapCheck.ok) return overlapCheck;

  const categoryCapCheck = validateRefundCategorySuggestedCapsNgn({
    calculationLines: lines,
    categorySuggestedMaxNgn,
    derivedCategoryMaxNgn,
    toleranceNgn,
  });
  if (!categoryCapCheck.ok) return categoryCapCheck;

  let sum = 0;
  const sumsByCategory = sumRefundCalculationLinesByCategoryNgn(lines);
  const overpayLineTotal = roundRefundMoney(sumsByCategory.Overpayment);
  if (overpayLineTotal > 0 && overpayMax >= 0 && overpayLineTotal > overpayMax + toleranceNgn) {
    return {
      ok: false,
      error: `Overpayment refund cannot exceed ₦${overpayMax.toLocaleString('en-NG')} (payment received minus quote total on this quotation).`,
    };
  }

  for (const line of lines) {
    if (line?.include === false) continue;
    const amt = roundRefundMoney(line.amountNgn);
    if (amt <= 0) continue;
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
