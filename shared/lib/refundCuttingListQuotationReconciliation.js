/**
 * Cross-check quoted roofing metres vs cutting list totals for refund safety.
 */

export const CUTTING_LIST_QUOTATION_METRE_TOLERANCE_M = 0.5;

/** Sum roof line metres from normalized cutting-list rows (ignores cladding / flatsheet). */
export function cuttingListRoofMetresFromLines(lines) {
  if (!Array.isArray(lines)) return 0;
  return lines.reduce((sum, line) => {
    const type = String(line?.lineType ?? line?.line_type ?? 'Roof').trim();
    if (type !== 'Roof') return sum;
    const tm = Number(line?.totalM ?? line?.total_m);
    if (Number.isFinite(tm) && tm > 0) return sum + tm;
    const sheets = Number(line?.sheets) || 0;
    const lengthM = Number(line?.lengthM ?? line?.length_m) || 0;
    if (sheets > 0 && lengthM > 0) return sum + Number((sheets * lengthM).toFixed(2));
    return sum;
  }, 0);
}

/**
 * Save-time gate: roof metres on the cutting list must match quoted roofing sheet metres.
 * @param {{
 *   quotedRoofingMetres: number,
 *   cuttingRoofMetres: number,
 *   accessoriesOnly?: boolean,
 *   toleranceM?: number,
 * }} p
 */
export function validateCuttingListQuotedRoofingAlignment({
  quotedRoofingMetres,
  cuttingRoofMetres,
  accessoriesOnly = false,
  toleranceM = CUTTING_LIST_QUOTATION_METRE_TOLERANCE_M,
}) {
  if (accessoriesOnly) {
    return { ok: true, quotedMetres: 0, cuttingRoofMetres: 0, deltaMetres: 0 };
  }
  const quoted = Number(quotedRoofingMetres) || 0;
  const cutting = Number(cuttingRoofMetres) || 0;
  if (quoted <= 0 && cutting > 0) {
    return {
      ok: false,
      code: 'cutting_list_no_quoted_roofing_metres',
      quotedMetres: quoted,
      cuttingRoofMetres: cutting,
      deltaMetres: cutting,
      message:
        'Quotation has no roofing sheet metres on file, but this cutting list has roof lines. Open the quotation, select the product line, and enter metres there first.',
    };
  }
  const assessment = assessCuttingListQuotationMetreVariance({
    quotedRoofingMetres: quoted,
    cuttingListMetresSum: cutting,
    toleranceM,
  });
  if (!assessment.ok) {
    return {
      ok: false,
      code: assessment.code,
      quotedMetres: assessment.quotedMetres,
      cuttingRoofMetres: assessment.cuttingListMetresSum,
      deltaMetres: assessment.deltaMetres,
      message: `Roof metres on this cutting list (${cutting.toFixed(2)} m) do not match quoted roofing sheet metres (${quoted.toFixed(2)} m) — difference ${assessment.deltaMetres.toFixed(2)} m. Align the list with the quotation before saving.`,
    };
  }
  return {
    ok: true,
    quotedMetres: quoted,
    cuttingRoofMetres: cutting,
    deltaMetres: assessment.deltaMetres ?? 0,
  };
}

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
