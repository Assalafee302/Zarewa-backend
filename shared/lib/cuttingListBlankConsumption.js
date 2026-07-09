/**
 * Quotation trim → coil blank consumption and cutting-list alignment.
 * Keep frontend mirror in Zarewa-frontend-main/src/lib/cuttingListBlankConsumption.js in sync.
 */

import { isMeterSheetProductLine } from './materialWorkbookQuotationPrice.js';
import { isStoneFlatsheetQuotationLine } from './stoneCoatedQuotationPolicy.js';
import { quotationLineQtyNumber } from './quotationLineNumericForRefund.js';
import {
  CUTTING_LIST_QUOTATION_METRE_TOLERANCE_M,
  cuttingListTotalMetresFromLines,
  roundCuttingListMetres2,
} from './refundCuttingListQuotationReconciliation.js';

export const COIL_BLANK_WIDTH_MM = 1200;

/** Soft warning when flatsheet section is slightly short of trim blank. */
export const TRIM_BLANK_SOFT_TOLERANCE_M = 0.1;

/** Hard block before production when trim blank is missing from flatsheet section. */
export const TRIM_BLANK_HARD_TOLERANCE_M = 0.25;

export const TRIM_GIRTH_OPTIONS_MM = Object.freeze([130, 150, 200, 300, 400, 600]);

const TRIM_PRODUCT_NAMES = new Set([
  'bargeboard',
  'top end',
  'gutter',
  'eaves angle',
  'eave angle',
  'wall flashing',
  'ridge cap',
  'capping',
  'bottom eaves',
  'fascia',
  'wall eaves',
]);

const EAVE_TRIM_PRODUCT_NAMES = new Set(['eaves angle', 'eave angle', 'bottom eaves', 'wall eaves']);

const SKIP_SHEET_POOL_NAMES = new Set(['coil', 'crimp', 'offcut']);

export function normQuoteProductLineName(name) {
  return String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** Finished-metre trim lines that consume coil as blank strips (not full 1200 mm). */
export function isQuotationTrimProductLine(name) {
  const n = normQuoteProductLineName(name);
  return Boolean(n && TRIM_PRODUCT_NAMES.has(n));
}

export function isQuotationEaveTrimLine(name) {
  const n = normQuoteProductLineName(name);
  return Boolean(n && EAVE_TRIM_PRODUCT_NAMES.has(n));
}

export function defaultGirthMmForTrimProduct(name) {
  if (isQuotationEaveTrimLine(name)) return 150;
  if (isQuotationTrimProductLine(name)) return 400;
  return 0;
}

/**
 * Pricing / persistence hint for quotation product JSON.
 * @param {string} name
 */
export function quotationLineKindForProductName(name) {
  const n = normQuoteProductLineName(name);
  if (!n) return '';
  if (isStoneFlatsheetQuotationLine(name)) return 'stone_coated';
  if (isMeterSheetProductLine(name) || n === 'cladding') return 'roofing';
  if (isQuotationTrimProductLine(name)) {
    return isQuotationEaveTrimLine(name) ? 'flashing' : 'ridge';
  }
  return '';
}

/**
 * @param {number} finishedM finished trim metres on the quotation
 * @param {number} girthMm strip width in mm
 */
export function finishedTrimMetresToBlankMetres(finishedM, girthMm) {
  const finished = Number(finishedM) || 0;
  const g = Number(girthMm) || 0;
  if (finished <= 0 || g <= 0 || g > COIL_BLANK_WIDTH_MM) return 0;
  return roundCuttingListMetres2((finished * g) / COIL_BLANK_WIDTH_MM);
}

function parseQuotationLinesPayload(linesJson) {
  let payload = linesJson;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload || '{}');
    } catch {
      payload = {};
    }
  }
  const products = payload?.products;
  return Array.isArray(products) ? products : [];
}

function sheetPoolKindForLine(line) {
  const name = line?.name;
  const n = normQuoteProductLineName(name);
  if (!n || SKIP_SHEET_POOL_NAMES.has(n)) return 'skip';
  if (isStoneFlatsheetQuotationLine(name)) return 'skip';
  if (isQuotationTrimProductLine(name)) return 'trim';
  if (n === 'cladding') return 'sheet_pool';
  if (isMeterSheetProductLine(name)) return 'sheet_pool';
  return 'skip';
}

/** Roofing / flat / cladding metres that map 1:1 to coil blank width (1200 mm). */
export function quotedCuttingListSheetPoolMetresFromProducts(linesJson) {
  return parseQuotationLinesPayload(linesJson).reduce((sum, line) => {
    if (sheetPoolKindForLine(line) !== 'sheet_pool') return sum;
    return sum + quotationLineQtyNumber(line);
  }, 0);
}

/**
 * @param {object} line quotation product row
 */
export function resolveTrimGirthMmForLine(line) {
  const explicit = Number(line?.girthMm ?? line?.girth ?? 0);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return defaultGirthMmForTrimProduct(line?.name);
}

/** Sum blank metres required on CL flatsheet for quoted trim lines. */
export function quotedTrimBlankMetresFromProducts(linesJson) {
  return roundCuttingListMetres2(
    parseQuotationLinesPayload(linesJson).reduce((sum, line) => {
      if (sheetPoolKindForLine(line) !== 'trim') return sum;
      const finishedM = quotationLineQtyNumber(line);
      const girthMm = resolveTrimGirthMmForLine(line);
      return sum + finishedTrimMetresToBlankMetres(finishedM, girthMm);
    }, 0)
  );
}

/** Trim lines on the quote that have finished metres but no usable width. */
export function quotationTrimLinesMissingGirth(linesJson) {
  return parseQuotationLinesPayload(linesJson)
    .filter((line) => sheetPoolKindForLine(line) === 'trim')
    .filter((line) => {
      const finishedM = quotationLineQtyNumber(line);
      if (finishedM <= 0) return false;
      const g = resolveTrimGirthMmForLine(line);
      return !(g > 0 && g <= COIL_BLANK_WIDTH_MM);
    })
    .map((line) => String(line?.name ?? '').trim())
    .filter(Boolean);
}

export function cuttingListFlatsheetMetresFromLines(lines) {
  return cuttingListTotalMetresFromLines(lines, { lineTypes: ['Flatsheet'] });
}

/**
 * Full quote ↔ cutting-list consumption check (sheet pool + trim blank).
 * @param {{
 *   quotationLinesJson: unknown,
 *   cuttingListLines?: object[],
 *   cuttingListMetres?: number,
 *   accessoriesOnly?: boolean,
 *   sheetToleranceM?: number,
 *   trimBlankSoftToleranceM?: number,
 *   trimBlankHardToleranceM?: number,
 * }} p
 */
export function assessCuttingListQuotationConsumption({
  quotationLinesJson,
  cuttingListLines,
  cuttingListMetres,
  accessoriesOnly = false,
  sheetToleranceM = CUTTING_LIST_QUOTATION_METRE_TOLERANCE_M,
  trimBlankSoftToleranceM = TRIM_BLANK_SOFT_TOLERANCE_M,
  trimBlankHardToleranceM = TRIM_BLANK_HARD_TOLERANCE_M,
}) {
  if (accessoriesOnly) {
    return {
      ok: true,
      warnings: [],
      quotedSheetPoolM: 0,
      quotedTrimBlankM: 0,
      expectedTotalM: 0,
      cuttingListTotalM: 0,
      clFlatsheetM: 0,
      trimBlankGapM: 0,
      trimBlankProductionBlocked: false,
      deltaMetres: 0,
    };
  }

  const quotedSheetPoolM = roundCuttingListMetres2(quotedCuttingListSheetPoolMetresFromProducts(quotationLinesJson));
  const quotedTrimBlankM = quotedTrimBlankMetresFromProducts(quotationLinesJson);
  const expectedTotalM = roundCuttingListMetres2(quotedSheetPoolM + quotedTrimBlankM);
  const cuttingListTotalM = roundCuttingListMetres2(
    cuttingListMetres ?? cuttingListTotalMetresFromLines(cuttingListLines ?? [])
  );
  const clFlatsheetM = roundCuttingListMetres2(cuttingListFlatsheetMetresFromLines(cuttingListLines ?? []));
  const trimBlankGapM = roundCuttingListMetres2(Math.max(0, quotedTrimBlankM - clFlatsheetM));
  const missingGirth = quotationTrimLinesMissingGirth(quotationLinesJson);

  const warnings = [];
  if (missingGirth.length) {
    warnings.push(
      `Set strip width (mm) on trim lines: ${missingGirth.join(', ')}. Default is 400 mm (150 mm for eaves).`
    );
  }
  if (quotedTrimBlankM > 0 && trimBlankGapM > trimBlankSoftToleranceM + 1e-6) {
    warnings.push(
      `Flatsheet section (${clFlatsheetM.toFixed(2)} m) is short of trim blank consumption (${quotedTrimBlankM.toFixed(2)} m) by ${trimBlankGapM.toFixed(2)} m. Add trim blank lines under Flatsheet.`
    );
  }

  const trimBlankProductionBlocked =
    quotedTrimBlankM > 0 && trimBlankGapM > trimBlankHardToleranceM + 1e-6;

  if (quotedSheetPoolM <= 0 && cuttingListTotalM > 0) {
    return {
      ok: false,
      code: 'cutting_list_no_quoted_roofing_metres',
      warnings,
      quotedSheetPoolM,
      quotedTrimBlankM,
      expectedTotalM,
      cuttingListTotalM,
      clFlatsheetM,
      trimBlankGapM,
      trimBlankProductionBlocked,
      deltaMetres: cuttingListTotalM,
      message:
        'Quotation has no roofing sheet metres on file, but this cutting list has metre lines. Open the quotation, select the product line, and enter metres there first.',
    };
  }

  const deltaMetres = roundCuttingListMetres2(Math.abs(expectedTotalM - cuttingListTotalM));
  const tol = Math.max(0, Number(sheetToleranceM) || 0);
  if (expectedTotalM > 0 && cuttingListTotalM > 0 && deltaMetres > tol + 1e-6) {
    const trimNote =
      quotedTrimBlankM > 0 ? ` (includes ${quotedTrimBlankM.toFixed(2)} m trim blank from quotation)` : '';
    return {
      ok: false,
      code: 'cutting_list_quotation_metre_mismatch',
      warnings,
      quotedSheetPoolM,
      quotedTrimBlankM,
      expectedTotalM,
      cuttingListTotalM,
      clFlatsheetM,
      trimBlankGapM,
      trimBlankProductionBlocked,
      deltaMetres,
      message: `Cutting list total (${cuttingListTotalM.toFixed(2)} m) does not match expected coil consumption (${expectedTotalM.toFixed(2)} m${trimNote}) — difference ${deltaMetres.toFixed(2)} m. Adjust sections so roof + cladding + flatsheet match the quotation.`,
    };
  }

  return {
    ok: true,
    warnings,
    quotedSheetPoolM,
    quotedTrimBlankM,
    expectedTotalM,
    cuttingListTotalM,
    clFlatsheetM,
    trimBlankGapM,
    trimBlankProductionBlocked,
    deltaMetres,
  };
}

/**
 * Production gate: trim blank must be recorded on the flatsheet section.
 * @param {{
 *   quotationLinesJson: unknown,
 *   cuttingListLines?: object[],
 *   trimBlankHardToleranceM?: number,
 * }} p
 */
export function validateCuttingListTrimBlankForProduction({
  quotationLinesJson,
  cuttingListLines,
  trimBlankHardToleranceM = TRIM_BLANK_HARD_TOLERANCE_M,
}) {
  const assessment = assessCuttingListQuotationConsumption({
    quotationLinesJson,
    cuttingListLines,
    trimBlankHardToleranceM,
  });
  if (!assessment.trimBlankProductionBlocked) {
    return { ok: true, warnings: assessment.warnings };
  }
  return {
    ok: false,
    code: 'cutting_list_trim_blank_missing',
    warnings: assessment.warnings,
    quotedTrimBlankM: assessment.quotedTrimBlankM,
    clFlatsheetM: assessment.clFlatsheetM,
    trimBlankGapM: assessment.trimBlankGapM,
    message: `Cutting list flatsheet section (${assessment.clFlatsheetM.toFixed(2)} m) is missing ${assessment.trimBlankGapM.toFixed(2)} m of trim blank required by the quotation (${assessment.quotedTrimBlankM.toFixed(2)} m total). Add trim under Flatsheet before production.`,
  };
}
