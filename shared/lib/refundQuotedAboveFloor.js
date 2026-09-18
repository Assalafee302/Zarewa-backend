/**
 * Quoted selling ₦/m minus workbook floor ₦/m × produced metres.
 * Frontend copies via `npm run sync:shared` → src/shared/lib/refundQuotedAboveFloor.js
 */

export function roundQuotedAboveFloorMoney(value) {
  return Math.round(Number(value) || 0);
}

/**
 * @param {number} quotedPpm selling ₦/m
 * @param {number} floorPpm workbook minimum ₦/m
 * @param {number} metres produced metres at that floor
 * @returns {number} integer ₦
 */
export function quotedAboveFloorCreditNgn(quotedPpm, floorPpm, metres) {
  const q = Number(quotedPpm);
  const f = Number(floorPpm);
  const m = Number(metres);
  if (!Number.isFinite(q) || q <= 0 || !Number.isFinite(f) || f <= 0 || !Number.isFinite(m) || m <= 0) {
    return 0;
  }
  const delta = q - f;
  if (delta <= 0.001) return 0;
  return roundQuotedAboveFloorMoney(delta * m);
}
