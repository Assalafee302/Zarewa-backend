/**
 * Coil vs quotation material spec (gauge / colour / type).
 * Frontend copies via `npm run sync:shared` → src/shared/lib/coilSpecVersusProduct.js
 */
import { stockRowMatchesColourFilter } from './stockCheckMasterOptions.js';
import {
  quotationHasCoilLine,
  quotationHasFlatSheetLine,
  quotationHasStoneCoilBackedProductLines,
  quotationProductLinesForJobProduct,
} from './stoneCoatedQuotationPolicy.js';

/** First numeric gauge in a label, e.g. "0.24mm" → 0.24 */
export function firstGaugeNumber(value) {
  const m = String(value ?? '').match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1], 10) : null;
}

/**
 * Parse expected gauge from product/quotation labels that may be a single value or a range
 * (e.g. "0.18–0.24mm", "0.18-0.24"). Returns mm bounds for comparison to coil gauge.
 * @returns {{ lo: number, hi: number } | null}
 */
export function expectedGaugeBoundsMm(expectedGaugeLabel) {
  const s = String(expectedGaugeLabel ?? '')
    .replace(/\u2013|\u2014|\u2212/g, '-')
    .trim();
  if (!s) return null;
  const nums = s.match(/(\d+(?:\.\d+)?)/g);
  if (!nums?.length) return null;
  const values = nums.map((x) => parseFloat(x, 10)).filter((n) => Number.isFinite(n));
  if (!values.length) return null;
  if (values.length === 1) return { lo: values[0], hi: values[0] };
  return { lo: Math.min(...values), hi: Math.max(...values) };
}

/** Finished-good / sellable product wording — not comparable to raw coil material_type_name. */
function skipMaterialCompareToCoil(expectedMaterialType) {
  const m = String(expectedMaterialType ?? '').toLowerCase();
  if (!m) return false;
  if (/\bfinished\b/.test(m)) return true;
  if (/\broofing sheet\b/.test(m)) return true;
  if (/\baccessory\b/.test(m)) return true;
  if (/\bsteeltile\b/.test(m) && !/\bcoil\b/.test(m)) return true;
  return false;
}

/**
 * @param {Record<string, unknown> | null | undefined} quotation
 */
export function firstPrimaryProductNameFromQuotation(quotation) {
  const named = String(quotation?.materialTypeName ?? quotation?.material_type_name ?? '').trim();
  if (named) return named;
  const mid = String(quotation?.materialTypeId ?? quotation?.material_type_id ?? '').trim();
  if (mid === 'MAT-001') return 'Aluminium';
  if (mid === 'MAT-002') return 'Aluzinc';
  if (mid === 'MAT-005' || mid === 'stone-coated') return 'Stone coated';
  return '';
}

/**
 * Merge quotation header material fields (lines_json) with finished-good product attrs.
 * @param {Record<string, unknown> | null | undefined} quotation
 * @param {{ gauge?: string; colour?: string; materialType?: string } | null | undefined} jobProductAttrs
 */
export function buildExpectedCoilSpecFromQuotation(quotation, jobProductAttrs) {
  const q = quotation || {};
  const p = jobProductAttrs || {};
  const gauge = String(q.materialGauge || p.gauge || '').trim();
  const colour = String(q.materialColor || p.colour || '').trim();
  let materialType = String(p.materialType || '').trim();
  if (!materialType) materialType = String(firstPrimaryProductNameFromQuotation(q) || '').trim();
  const design = String(q.materialDesign || '').trim();
  return {
    gauge: gauge || null,
    colour: colour || null,
    materialType: materialType || null,
    design: design || null,
  };
}

/**
 * @param {Record<string, unknown> | null | undefined} lot — gaugeLabel, colour, materialTypeName (optional colourRaw)
 * @param {{ gauge?: string | null; colour?: string | null; materialType?: string | null }} expected from buildExpectedCoilSpecFromQuotation
 * @param {{ colours?: object[] } | null | undefined} [masterData] — when present, colour match uses Setup colour names ↔ abbreviations (e.g. Bush Green vs BG), same as Sales stock filters.
 * @returns {{ issues: string[], hasExpected: boolean }}
 */
export function coilSpecMismatchIssues(lot, expected, masterData) {
  if (!lot || !expected) return { issues: [], hasExpected: false };
  const gBounds = expectedGaugeBoundsMm(expected.gauge);
  const gCoil = firstGaugeNumber(lot.gaugeLabel);
  const cExp = String(expected.colour || '').trim().toLowerCase();
  const cCoil = String(lot.colour || '').trim().toLowerCase();
  const mMatRaw = String(expected.materialType || '').trim();
  const mExp = skipMaterialCompareToCoil(mMatRaw) ? '' : mMatRaw.toLowerCase();
  const mCoil = String(lot.materialTypeName || '').trim().toLowerCase();

  const hasExpected = gBounds != null || cExp.length > 0 || mExp.length > 0;
  if (!hasExpected) return { issues: [], hasExpected: false };

  const issues = [];
  if (gBounds && gCoil != null) {
    const tol = 0.02;
    if (gCoil < gBounds.lo - tol || gCoil > gBounds.hi + tol) {
      issues.push(`gauge (coil ${lot.gaugeLabel || '—'} vs quotation ${expected.gauge || '—'})`);
    }
  }
  if (cExp && cCoil) {
    let colourOk = cCoil.includes(cExp) || cExp.includes(cCoil);
    if (!colourOk && Array.isArray(masterData?.colours) && masterData.colours.length) {
      colourOk = stockRowMatchesColourFilter(masterData, String(expected.colour || '').trim(), {
        colour: lot.colour,
        colourRaw: lot.colourRaw ?? lot.colour,
      });
    }
    if (!colourOk) {
      issues.push(`colour (coil ${lot.colour || '—'} vs quotation ${expected.colour || '—'})`);
    }
  }
  if (mExp && mCoil) {
    const a = mExp.split(/\s+/)[0];
    const b = mCoil.split(/\s+/)[0];
    if (a.length > 2 && b.length > 2 && !mCoil.includes(a) && !mExp.includes(b)) {
      issues.push(`material (coil ${lot.materialTypeName || '—'} vs quotation ${expected.materialType || '—'})`);
    }
  }
  return { issues, hasExpected: true };
}

/** @param {Record<string, unknown> | null | undefined} quotation */
function quotationProductsFromQuotation(quotation) {
  const q = quotation?.quotationLines?.products;
  return Array.isArray(q) ? q : [];
}

/**
 * Stone metre quotes expect coil matching only when Flat sheet, Gutter, and/or Coil lines are present (hybrid jobs).
 * @param {Record<string, unknown> | null | undefined} quotation
 * @param {{ jobProductName?: string | null } | undefined} [opts]
 *   `jobProductName` scopes the check to one production job's own product line (see
 *   `quotationProductLinesForJobProduct`) so a job whose own product is "Roofing Sheet" doesn't
 *   pick up coil allocation just because a sibling "Flat sheet" line exists on the same
 *   multi-line quotation, and vice versa. Omit to check the whole quotation.
 */
export function quotationExpectsCoilAllocation(quotation, opts) {
  const allProducts = quotationProductsFromQuotation(quotation);
  const products = quotationProductLinesForJobProduct(allProducts, opts?.jobProductName);
  const mid = String(quotation?.materialTypeId ?? quotation?.material_type_id ?? '').trim();
  const stone =
    quotation?.stoneMeterQuote === true ||
    mid === 'MAT-005' ||
    mid === 'stone-coated';
  if (stone) {
    return (
      quotationHasStoneCoilBackedProductLines(products) ||
      quotationHasFlatSheetLine(products) ||
      quotationHasCoilLine(products)
    );
  }
  return true;
}

export function coilMatchesQuotationSpec(lot, quotation, jobProductAttrs, masterData) {
  if (quotation && !quotationExpectsCoilAllocation(quotation)) return true;
  const expected = buildExpectedCoilSpecFromQuotation(quotation, jobProductAttrs);
  const { issues, hasExpected } = coilSpecMismatchIssues(lot, expected, masterData);
  if (!hasExpected) return true;
  return issues.length === 0;
}

/**
 * Compare selected coil lot to quotation + finished-good attrs (storekeeper warning).
 * @returns {string | null} Warning sentence or null if aligned / insufficient data
 */
export function coilVersusQuotationAndProductWarning(lot, quotation, jobProductAttrs, masterData) {
  const expected = buildExpectedCoilSpecFromQuotation(quotation, jobProductAttrs);
  const { issues, hasExpected } = coilSpecMismatchIssues(lot, expected, masterData);
  if (!hasExpected || issues.length === 0) return null;
  return `Spec check: this coil does not match the quotation material spec — ${issues.join('; ')}. Pick a recommended coil or save with acknowledgement to flag the branch manager.`;
}

/**
 * Compare selected coil lot to finished-good product attrs only (no quotation header).
 * @param {Record<string, unknown> | null | undefined} lot
 * @param {{ gauge?: string; colour?: string; materialType?: string } | null | undefined} jobProductAttrs
 * @param {{ colours?: object[] } | null | undefined} [masterData]
 * @returns {string | null} Warning sentence or null if aligned / insufficient data
 */
export function coilVersusJobProductWarning(lot, jobProductAttrs, masterData) {
  return coilVersusQuotationAndProductWarning(lot, null, jobProductAttrs, masterData);
}
