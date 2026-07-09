/**
 * DB-backed quote ↔ cutting-list consumption checks (refund data quality, manager audit).
 */
import { assessCuttingListQuotationConsumption } from '../shared/lib/cuttingListBlankConsumption.js';
import { cuttingListTotalMetresFromLines } from '../shared/lib/refundCuttingListQuotationReconciliation.js';
import { parseQuotationAccessoryLines } from './accessoryFulfillment.js';
import { isStoneMeterQuotationLinesJson } from './stoneInventory.js';

function quotationHasPositiveProductLines(linesJson) {
  let payload = linesJson;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload || '{}');
    } catch {
      payload = {};
    }
  }
  const products = payload?.products;
  if (!Array.isArray(products)) return false;
  return products.some((line) => {
    const qty = Number(String(line?.qty ?? '').replace(/,/g, '')) || 0;
    const name = String(line?.name ?? '').trim();
    return name && qty > 0;
  });
}

function quotationHasPositiveServices(linesJson) {
  let payload = linesJson;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload || '{}');
    } catch {
      payload = {};
    }
  }
  const arr = payload?.services;
  if (!Array.isArray(arr)) return false;
  return arr.some((row) => {
    const name = String(row?.name ?? '').trim();
    const qty = Number(String(row?.qty ?? '').replace(/,/g, '')) || 0;
    return name && qty > 0;
  });
}

function quotationIsAccessoriesOnlyForConsumption(db, quotationRef) {
  const ref = String(quotationRef ?? '').trim();
  if (!ref) return false;
  let row;
  try {
    row = db.prepare(`SELECT lines_json FROM quotations WHERE id = ?`).get(ref);
  } catch {
    return false;
  }
  if (!row) return false;
  const hasNonProductLines =
    parseQuotationAccessoryLines(row.lines_json).length > 0 ||
    quotationHasPositiveServices(row.lines_json);
  return hasNonProductLines && !quotationHasPositiveProductLines(row.lines_json);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} quotationRef
 */
export function cuttingListLineRowsForQuotationRef(db, quotationRef) {
  const ref = String(quotationRef ?? '').trim();
  if (!ref) return [];
  let cuttingLists = [];
  try {
    cuttingLists = db.prepare(`SELECT id FROM cutting_lists WHERE quotation_ref = ?`).all(ref);
  } catch {
    return [];
  }
  const out = [];
  for (const cl of cuttingLists) {
    const rows = db
      .prepare(
        `SELECT sheets, length_m, total_m, line_type FROM cutting_list_lines WHERE cutting_list_id = ? ORDER BY sort_order`
      )
      .all(cl.id);
    for (const row of rows) {
      out.push({
        sheets: Number(row.sheets) || 0,
        lengthM: Number(row.length_m) || 0,
        totalM: Number(row.total_m) || 0,
        lineType: row.line_type || 'Roof',
      });
    }
  }
  return out;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} quotationRef
 */
export function assessQuotationCuttingListConsumptionForRef(db, quotationRef) {
  const ref = String(quotationRef ?? '').trim();
  if (!ref) return null;
  let quote;
  try {
    quote = db.prepare(`SELECT lines_json FROM quotations WHERE id = ?`).get(ref);
  } catch {
    return null;
  }
  if (!quote) return null;
  const accessoriesOnly = quotationIsAccessoriesOnlyForConsumption(db, ref);
  const stoneMeterQuote = isStoneMeterQuotationLinesJson(db, quote?.lines_json ?? '');
  const cuttingListLines = cuttingListLineRowsForQuotationRef(db, ref);
  return assessCuttingListQuotationConsumption({
    quotationLinesJson: quote?.lines_json ?? '',
    cuttingListLines,
    accessoriesOnly,
    stoneMeterQuote,
  });
}

/**
 * Quoted coil consumption vs cutting list totals — refund data quality (sheet pool + trim blank).
 * @param {import('better-sqlite3').Database} db
 * @param {string} quotationRef
 */
export function refundCuttingListQuotationMetreIssues(db, quotationRef) {
  const assessment = assessQuotationCuttingListConsumptionForRef(db, quotationRef);
  if (!assessment) return [];
  const cuttingListMetresSum = assessment.cuttingListTotalM ?? 0;
  const issues = [];
  const totalMismatchCodes = new Set([
    'cutting_list_quotation_metre_mismatch',
    'cutting_list_no_quoted_roofing_metres',
    'cutting_list_missing_for_quotation',
  ]);
  const totalAlreadyBlocked = !assessment.ok && totalMismatchCodes.has(String(assessment.code || '').trim());

  if (!assessment.ok && assessment.message) {
    issues.push({
      code: assessment.code || 'cutting_list_quotation_metre_mismatch',
      severity: 'error',
      message: assessment.message,
      quotedMetres: assessment.expectedTotalM,
      quotedSheetPoolM: assessment.quotedSheetPoolM,
      quotedTrimBlankM: assessment.quotedTrimBlankM,
      cuttingListMetresSum,
      deltaMetres: assessment.deltaMetres,
      trimBlankGapM: assessment.trimBlankGapM,
    });
  }
  for (const warning of assessment.warnings || []) {
    if (totalAlreadyBlocked && String(warning).includes('Flatsheet section')) continue;
    issues.push({
      code: 'trim_blank_cl_soft_warning',
      severity: 'warning',
      message: warning,
      quotedTrimBlankM: assessment.quotedTrimBlankM,
      clFlatsheetM: assessment.clFlatsheetM,
      trimBlankGapM: assessment.trimBlankGapM,
    });
  }
  if (assessment.trimBlankProductionBlocked && !totalAlreadyBlocked) {
    issues.push({
      code: 'trim_blank_cl_missing',
      severity: 'error',
      message: `Cutting list flatsheet section (${Number(assessment.clFlatsheetM || 0).toFixed(2)} m) is missing ${Number(assessment.trimBlankGapM || 0).toFixed(2)} m of trim blank required by the quotation (${Number(assessment.quotedTrimBlankM || 0).toFixed(2)} m).`,
      quotedTrimBlankM: assessment.quotedTrimBlankM,
      clFlatsheetM: assessment.clFlatsheetM,
      trimBlankGapM: assessment.trimBlankGapM,
    });
  }
  return issues;
}
