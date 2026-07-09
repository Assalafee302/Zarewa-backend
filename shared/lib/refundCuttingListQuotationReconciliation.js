/**
 * Cross-check quoted roofing metres vs cutting list totals for refund safety.
 */

export const CUTTING_LIST_QUOTATION_METRE_TOLERANCE_M = 0.5;

/**
 * @param {{
 *   quotedRoofingMetres: number,
 *   cuttingListMetresSum: number,
 *   toleranceM?: number,
 * }} p
 */
export function assessCuttingListQuotationMetreVariance({
  quotedRoofingMetres,
  cuttingListMetresSum,
  toleranceM = CUTTING_LIST_QUOTATION_METRE_TOLERANCE_M,
}) {
  const quoted = Number(quotedRoofingMetres) || 0;
  const cutting = Number(cuttingListMetresSum) || 0;
  if (quoted <= 0 || cutting <= 0) {
    return { ok: true, quotedMetres: quoted, cuttingListMetresSum: cutting, deltaMetres: 0 };
  }
  const delta = Math.abs(quoted - cutting);
  if (delta <= Math.max(0, Number(toleranceM) || 0)) {
    return { ok: true, quotedMetres: quoted, cuttingListMetresSum: cutting, deltaMetres: delta };
  }
  return {
    ok: false,
    code: 'cutting_list_quotation_metre_mismatch',
    quotedMetres: quoted,
    cuttingListMetresSum: cutting,
    deltaMetres: delta,
    message: `Cutting list total (${cutting.toFixed(
      2
    )} m) differs from quoted roofing metres (${quoted.toFixed(
      2
    )} m) by ${delta.toFixed(2)} m — verify before unproduced refund.`,
  };
}
