/**
 * Cross-check quoted roofing metres vs cutting list totals for refund safety.
 */

import { assessCuttingListQuotationConsumption } from './cuttingListBlankConsumption.js';

export const CUTTING_LIST_QUOTATION_METRE_TOLERANCE_M = 0.5;

/** @param {unknown} linesJson */
export function hasQuotationProductsPayload(linesJson) {
  if (linesJson == null || linesJson === '') return false;
  let payload = linesJson;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload || '{}');
    } catch {
      return false;
    }
  }
  return Array.isArray(payload?.products);
}

export function roundCuttingListMetres2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function cuttingListLineMetres(line) {
  const tm = Number(line?.totalM ?? line?.total_m);
  if (Number.isFinite(tm) && tm > 0) return tm;
  const sheets = Number(line?.sheets) || 0;
  const lengthM = Number(line?.lengthM ?? line?.length_m) || 0;
  if (sheets > 0 && lengthM > 0) return Number((sheets * lengthM).toFixed(2));
  return 0;
}

/**
 * Sum metres on cutting-list rows (all sections by default), matching server line rounding.
 * @param {object[]} lines
 * @param {{ lineTypes?: string[] | null }} [opts]
 */
export function cuttingListTotalMetresFromLines(lines, { lineTypes = null } = {}) {
  if (!Array.isArray(lines)) return 0;
  const allow = lineTypes ? new Set(lineTypes) : null;
  const sum = lines.reduce((acc, line) => {
    const type = String(line?.lineType ?? line?.line_type ?? 'Roof').trim();
    if (allow && !allow.has(type)) return acc;
    return acc + cuttingListLineMetres(line);
  }, 0);
  return roundCuttingListMetres2(sum);
}

/** Sum roof line metres only (production / stone run-plan). */
export function cuttingListRoofMetresFromLines(lines) {
  return cuttingListTotalMetresFromLines(lines, { lineTypes: ['Roof'] });
}

/**
 * Save-time gate: cutting list coil consumption must match the quotation.
 * @param {{
 *   quotedRoofingMetres?: number,
 *   quotationLinesJson?: unknown,
 *   cuttingListLines?: object[],
 *   cuttingListMetres?: number,
 *   cuttingRoofMetres?: number,
 *   accessoriesOnly?: boolean,
 *   stoneMeterQuote?: boolean,
 *   toleranceM?: number,
 * }} p
 */
export function validateCuttingListQuotedRoofingAlignment({
  quotedRoofingMetres,
  quotationLinesJson,
  cuttingListLines,
  cuttingListMetres,
  cuttingRoofMetres,
  accessoriesOnly = false,
  stoneMeterQuote = false,
  toleranceM = CUTTING_LIST_QUOTATION_METRE_TOLERANCE_M,
}) {
  if (hasQuotationProductsPayload(quotationLinesJson)) {
    const assessment = assessCuttingListQuotationConsumption({
      quotationLinesJson,
      cuttingListLines,
      cuttingListMetres,
      accessoriesOnly,
      stoneMeterQuote,
      sheetToleranceM: toleranceM,
    });
    return {
      ok: assessment.ok,
      code: assessment.code,
      quotedMetres: assessment.expectedTotalM ?? 0,
      quotedSheetPoolM: assessment.quotedSheetPoolM ?? 0,
      quotedTrimBlankM: assessment.quotedTrimBlankM ?? 0,
      cuttingListMetres: assessment.cuttingListTotalM ?? 0,
      deltaMetres: assessment.deltaMetres ?? 0,
      warnings: assessment.warnings ?? [],
      message: assessment.message,
    };
  }

  if (accessoriesOnly) {
    return { ok: true, quotedMetres: 0, cuttingListMetres: 0, deltaMetres: 0 };
  }
  const quoted = roundCuttingListMetres2(quotedRoofingMetres);
  const cutting = roundCuttingListMetres2(cuttingListMetres ?? cuttingRoofMetres ?? 0);
  if (quoted <= 0 && cutting > 0) {
    return {
      ok: false,
      code: 'cutting_list_no_quoted_roofing_metres',
      quotedMetres: quoted,
      cuttingListMetres: cutting,
      deltaMetres: cutting,
      message:
        'Quotation has no roofing sheet metres on file, but this cutting list has metre lines. Open the quotation, select the product line, and enter metres there first.',
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
      cuttingListMetres: assessment.cuttingListMetresSum,
      deltaMetres: assessment.deltaMetres,
      message: `Cutting list total (${cutting.toFixed(2)} m) does not match quoted roofing sheet metres (${quoted.toFixed(2)} m) — difference ${assessment.deltaMetres.toFixed(2)} m. Adjust lines so the list total matches the quotation.`,
    };
  }
  return {
    ok: true,
    quotedMetres: quoted,
    cuttingListMetres: cutting,
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
  const quoted = roundCuttingListMetres2(quotedRoofingMetres);
  const cutting = roundCuttingListMetres2(cuttingListMetresSum);
  if (quoted <= 0 || cutting <= 0) {
    return { ok: true, quotedMetres: quoted, cuttingListMetresSum: cutting, deltaMetres: 0 };
  }
  const signedDeltaM = roundCuttingListMetres2(cutting - quoted);
  const delta = Math.abs(signedDeltaM);
  const tol = Math.max(0, Number(toleranceM) || 0);
  if (delta <= tol + 1e-6) {
    return {
      ok: true,
      quotedMetres: quoted,
      cuttingListMetresSum: cutting,
      deltaMetres: delta,
      signedDeltaM,
    };
  }
  // Cutting list above quote — hard verify. Under-quote is allowed (partial / unproduced).
  if (signedDeltaM > 0) {
    return {
      ok: false,
      code: 'cutting_list_quotation_metre_mismatch',
      quotedMetres: quoted,
      cuttingListMetresSum: cutting,
      deltaMetres: delta,
      signedDeltaM,
      message: `Cutting list total (${cutting.toFixed(
        2
      )} m) exceeds quoted roofing metres (${quoted.toFixed(
        2
      )} m) by ${delta.toFixed(2)} m — verify before refund.`,
    };
  }
  return {
    ok: true,
    code: 'cutting_list_quotation_metre_under',
    quotedMetres: quoted,
    cuttingListMetresSum: cutting,
    deltaMetres: delta,
    signedDeltaM,
    message: `Cutting list total (${cutting.toFixed(
      2
    )} m) is ${delta.toFixed(2)} m below quoted roofing metres (${quoted.toFixed(
      2
    )} m) — under-quote lists are allowed; leftover may be unproduced.`,
  };
}
