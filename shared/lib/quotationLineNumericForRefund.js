/**
 * Parse qty / unit price from quotation `lines_json` product rows.
 * Matches writeOps / quotationJsonLineAmountNgn (comma thousands, alternate keys).
 * Frontend copies via `npm run sync:shared` → src/shared/lib/quotationLineNumericForRefund.js
 */

export function quotationLineQtyNumber(line) {
  return Number(String(line?.qty ?? line?.quantity ?? '').replace(/,/g, '')) || 0;
}

export function quotationLineUnitPriceNumber(line) {
  if (line?.unitPrice != null && line.unitPrice !== '')
    return Number(String(line.unitPrice).replace(/,/g, '')) || 0;
  if (line?.unit_price != null && line.unit_price !== '')
    return Number(String(line.unit_price).replace(/,/g, '')) || 0;
  if (line?.unit_price_ngn != null) return Number(line.unit_price_ngn) || 0;
  return 0;
}
