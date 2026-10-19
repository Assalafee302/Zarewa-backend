/**
 * Finance Phase A (A5): a haulage or supplier payout above the quoted / approved amount is
 * refused unless a Branch Manager / Operations Manager approves it with a reason. The approved
 * excess then posts as its own treasury line carrying that reason.
 */

function money(n) {
  return Math.max(0, Math.round(Number(n) || 0));
}

/**
 * @param {{ capNgn: number, alreadyPaidNgn: number, payNgn: number }} p
 * @returns {{ capNgn: number, alreadyPaidNgn: number, payNgn: number, withinNgn: number, excessNgn: number }}
 */
export function overQuoteSplit({ capNgn, alreadyPaidNgn, payNgn }) {
  const cap = money(capNgn);
  const paid = money(alreadyPaidNgn);
  const pay = money(payNgn);
  if (cap <= 0) return { capNgn: cap, alreadyPaidNgn: paid, payNgn: pay, withinNgn: pay, excessNgn: 0 };
  const withinNgn = Math.min(pay, Math.max(0, cap - paid));
  return { capNgn: cap, alreadyPaidNgn: paid, payNgn: pay, withinNgn, excessNgn: pay - withinNgn };
}

const fmt = (n) => `₦${money(n).toLocaleString('en-NG')}`;

/**
 * @param {ReturnType<typeof overQuoteSplit>} split
 * @param {{ what: string, ref: string, capLabel: string }} label e.g. { what: 'Haulage', ref: 'PO-KD-26-0070', capLabel: 'quoted fee' }
 */
export function overQuoteRefusal(split, { what, ref, capLabel }) {
  return {
    ok: false,
    code: 'PAYOUT_ABOVE_QUOTE',
    error: `${what} on ${ref}: paying ${fmt(split.payNgn)} takes the total to ${fmt(split.alreadyPaidNgn + split.payNgn)}, above the ${capLabel} of ${fmt(split.capNgn)} by ${fmt(split.excessNgn)}. A Branch Manager or Operations Manager must approve the excess with a reason.`,
    ...split,
  };
}

export function overQuoteExcessNote({ reason, approverName, capLabel }) {
  return `Above ${capLabel} — approved by ${String(approverName || 'manager').trim()}: ${String(reason || '').trim()}`;
}
