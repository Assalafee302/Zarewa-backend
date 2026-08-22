/**
 * Quoted haulage fee on a PO — total transport_amount_ngn when set, else advance-only quote.
 * Frontend copies via `npm run sync:shared` → src/shared/lib/poTransportFee.js
 * @param {{ transport_amount_ngn?: number | null; transportAmountNgn?: number | null; transport_advance_ngn?: number | null; transportAdvanceNgn?: number | null } | null | undefined} row
 */
export function poTransportQuotedFeeNgn(row) {
  const total = Math.max(0, Number(row?.transport_amount_ngn ?? row?.transportAmountNgn) || 0);
  if (total > 0) return total;
  return Math.max(0, Number(row?.transport_advance_ngn ?? row?.transportAdvanceNgn) || 0);
}

/** PO statuses where treasury may still owe haulage. */
export const PO_TRANSPORT_TREASURY_PAYABLE_STATUSES = [
  'approved',
  'on loading',
  'in transit',
  'received',
];
