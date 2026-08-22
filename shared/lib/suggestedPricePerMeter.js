/**
 * Shared suggested ₦/m from workbook economics.
 * Frontend copies via `npm run sync:shared` → src/shared/lib/suggestedPricePerMeter.js
 */

/**
 * @param {number | null | undefined} convUsed
 * @param {number | null | undefined} costPerKg
 * @param {number | null | undefined} overheadPerM
 * @param {number | null | undefined} profitPerM
 * @returns {number | null}
 */
export function suggestedPricePerMeterNgn(convUsed, costPerKg, overheadPerM, profitPerM) {
  const u = Number(convUsed);
  const ck = Number(costPerKg);
  const oh = Number(overheadPerM) || 0;
  const pr = Number(profitPerM) || 0;
  if (!Number.isFinite(u) || u <= 0 || !Number.isFinite(ck) || ck < 0) return null;
  return Math.round(u * ck + oh + pr);
}
