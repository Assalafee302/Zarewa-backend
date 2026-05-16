/**
 * Refund headroom on a quotation: cash received on this quote only (not unrelated customer balance).
 * When cash in exceeds the quote total, refundable excess = cash in − quote total − refunds already reserved.
 * Otherwise refundable headroom = cash in − refunds already reserved.
 */

export function roundRefundMoney(value) {
  return Math.round(Number(value) || 0);
}

/**
 * @param {{ cashInNgn: number, quoteTotalNgn: number, totalRefundedNgn: number }} p
 * @returns {number}
 */
export function quotationRefundHeadroomNgn({ cashInNgn, quoteTotalNgn, totalRefundedNgn }) {
  const cashIn = roundRefundMoney(cashInNgn);
  const quoteTotal = roundRefundMoney(quoteTotalNgn);
  const refunded = roundRefundMoney(totalRefundedNgn);
  if (cashIn <= 0) return 0;
  if (quoteTotal > 0 && cashIn > quoteTotal) {
    return Math.max(0, cashIn - quoteTotal - refunded);
  }
  return Math.max(0, cashIn - refunded);
}

/**
 * Excess cash on this quotation above the quote total (before refunds).
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
 * Economic cash on one quotation for refund caps — avoids counting OVERPAY_ADVANCE twice when
 * staff post again on an already-settled quote (companion split overpay is already in receipt cash).
 *
 * @param {{
 *   receiptCashNgn: number,
 *   advanceAppliedNgn?: number,
 *   netOverpayLedgerNgn?: number,
 *   companionOverpayOnQuoteNgn?: number,
 *   settledQuoteFullOverpayNgn?: number,
 * }} p
 * @returns {number}
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

/**
 * When preview lines exceed remaining refundable headroom, allocate budget in this order.
 * Contractual / shortfall lines first; overpayment excess (cash above quote total) last.
 */
export const REFUND_LINE_HEADROOM_PRIORITY = [
  'Order cancellation',
  'Unproduced meterage',
  'Substitution Difference',
  'Accessory shortfall',
  'Stone flatsheet shortfall',
  'Transport issue',
  'Installation issue',
  'Additional services',
  'Calculation error',
  'Customer commission',
  'Overpayment',
  'Other',
];

function headroomPriorityIndex(category) {
  const c = String(category || '').trim();
  const i = REFUND_LINE_HEADROOM_PRIORITY.indexOf(c);
  return i >= 0 ? i : REFUND_LINE_HEADROOM_PRIORITY.length;
}

/**
 * Cap automatic preview lines so their sum never exceeds quotation refundable headroom.
 * @param {Array<{ label?: string, amountNgn?: number, category?: string, appliesToCategories?: string[] }>} suggestedLines
 * @param {number | null | undefined} remainingNgn
 * @returns {{ lines: typeof suggestedLines, warnings: string[] }}
 */
export function capSuggestedRefundLinesToHeadroom(suggestedLines, remainingNgn) {
  const remaining = roundRefundMoney(remainingNgn);
  const warnings = [];
  const input = Array.isArray(suggestedLines) ? suggestedLines : [];
  const positive = input.filter((l) => roundRefundMoney(l?.amountNgn) > 0);
  if (remaining <= 0) {
    if (positive.length > 0) {
      warnings.push(
        'No refundable headroom remains on this quotation — automatic lines were cleared (existing refunds or no cash on quote).'
      );
    }
    return { lines: [], warnings };
  }

  const totalWant = positive.reduce((s, l) => s + roundRefundMoney(l.amountNgn), 0);
  if (totalWant <= remaining) {
    return { lines: positive, warnings };
  }

  const sorted = positive
    .map((line, index) => ({ line, index }))
    .sort((a, b) => {
      const pa = headroomPriorityIndex(a.line?.category);
      const pb = headroomPriorityIndex(b.line?.category);
      if (pa !== pb) return pa - pb;
      return a.index - b.index;
    });

  let budget = remaining;
  /** @type {typeof suggestedLines} */
  const lines = [];

  for (const { line } of sorted) {
    const want = roundRefundMoney(line?.amountNgn);
    if (want <= 0) continue;
    const give = Math.min(want, budget);
    const cat = String(line?.category || 'Other').trim() || 'Other';
    if (give < want) {
      warnings.push(
        `${cat}: ₦${give.toLocaleString('en-NG')} of ₦${want.toLocaleString('en-NG')} (shared refundable cap ₦${remaining.toLocaleString('en-NG')} on this quotation).`
      );
    }
    if (give <= 0) {
      if (want > 0) {
        warnings.push(
          `${cat} not auto-filled: no headroom left after other applicable lines (you may add a manual line within the ₦${remaining.toLocaleString('en-NG')} cap).`
        );
      }
      continue;
    }
    lines.push({
      ...line,
      amountNgn: give,
      ...(give < want ? { originalAmountNgn: want } : {}),
    });
    budget -= give;
  }

  return { lines, warnings };
}
