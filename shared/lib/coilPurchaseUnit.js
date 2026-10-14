/**
 * How a coil PO line was bought (owner, 2026-10-14). Aluminium is often bought BY THE METRE; the PO line then
 * stores metres in the kg field and the per-metre price as a per-kg price. Shared by the purchase register and the
 * material (coil) register. Phase 4 adds an explicit unit to PO lines; until then this rule decides.
 */

/** Aluminium priced at or above this per "kg" on a PO line is really a per-metre price. */
export const METRE_PRICE_THRESHOLD_NGN = 9000;

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function isAluminiumLine(line) {
  if (String(line?.productID || '') === 'COIL-ALU') return true;
  return /alumin/i.test(String(line?.productName || line?.materialTypeName || ''));
}

/**
 * Aluminium is "metre" when any of: lineType coil_meter; metersOffered equals qtyOrdered (kg lines never match);
 * unit price ≥ METRE_PRICE_THRESHOLD_NGN. Everything else (and all aluzinc) is "kg".
 * @returns {{ unit: 'kg' | 'metre', rule: string }}
 */
export function purchaseUnitForLine(line) {
  if (!isAluminiumLine(line)) return { unit: 'kg', rule: 'Aluzinc is bought by kg' };
  if (String(line?.lineType || '') === 'coil_meter') return { unit: 'metre', rule: 'PO line type coil_meter' };
  const metres = num(line?.metersOffered);
  if (metres > 0 && Math.abs(metres - num(line?.qtyOrdered)) < 1e-6) {
    return { unit: 'metre', rule: 'metres offered = quantity ordered' };
  }
  const price = num(line?.unitPricePerKgNgn) || num(line?.unitPriceNgn);
  if (price >= METRE_PRICE_THRESHOLD_NGN) {
    return { unit: 'metre', rule: `price ≥ ₦${METRE_PRICE_THRESHOLD_NGN.toLocaleString('en-NG')}` };
  }
  return { unit: 'kg', rule: 'aluminium priced per kg' };
}

/** Amount paid for a PO line (quantity ordered × price; for metre lines that is metres × price per metre). */
export function poLineAmountNgn(line) {
  return num(line?.qtyOrdered) * (num(line?.unitPricePerKgNgn) || num(line?.unitPriceNgn));
}
