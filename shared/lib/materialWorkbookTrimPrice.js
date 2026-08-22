/**
 * Trim / ridge list price from material pricing workbook + ridge add-on policy.
 * Frontend copies via `npm run sync:shared` → src/shared/lib/materialWorkbookTrimPrice.js
 */

import {
  gaugeMmKeyFromLabel,
  normPricingKey,
  publishedListPriceFromWorkbook,
  resolveMaterialWorkbookPriceFromRows,
  roundPublishedPriceNgn,
} from './materialWorkbookQuotationPrice.js';
import {
  isQuotationTrimProductLine,
  resolveTrimGirthMmForLine,
} from './cuttingListBlankConsumption.js';
import { quotationLineQtyNumber } from './quotationLineNumericForRefund.js';

/**
 * @param {Array<{ girthMm?: number | string; materialFamily?: string; addOnNgn?: number; listAddOnNgn?: number | null }>} ridgeAddOns
 * @param {string} materialKey
 * @param {number} girthMm
 */
export function ridgeMatchedAddOnRow(ridgeAddOns, materialKey, girthMm) {
  const g = Number(girthMm);
  if (!Number.isFinite(g) || g <= 0) return null;
  const rows = (ridgeAddOns || []).filter((r) => Math.abs(Number(r?.girthMm) - g) < 0.001);
  if (!rows.length) return null;
  const mk = normPricingKey(materialKey);
  const exact = rows.find((r) => normPricingKey(r?.materialFamily) === mk);
  if (exact) return exact;
  const familyHint = rows.find((r) => {
    const mf = normPricingKey(r?.materialFamily);
    return (mk === 'alu' && mf.includes('alu')) || (mk === 'aluzinc' && (mf.includes('zinc') || mf.includes('ppgi')));
  });
  if (familyHint) return familyHint;
  return rows.find((r) => !normPricingKey(r?.materialFamily)) || null;
}

/** Customer list add-on; falls back to internal add-on when list add-on unset. */
export function customerRidgeListAddOnNgn(row) {
  if (row?.listAddOnNgn != null && row.listAddOnNgn !== '' && Number.isFinite(Number(row.listAddOnNgn))) {
    return Math.max(0, Math.round(Number(row.listAddOnNgn)));
  }
  return Math.max(0, Math.round(Number(row?.addOnNgn) || 0));
}

/**
 * Highest published list NGN/m for material + gauge + branch (ridge grid base when design is unset).
 * @param {Array<{ materialKey?: string; gaugeMm?: string; branchId?: string; minimumPricePerMeterNgn?: number; commissionNgnPerM?: number; publishedListPriceNgn?: number }>} rows
 */
export function maxPublishedListPerMeterForMatGauge(rows, materialKey, gaugeLabel, branchId) {
  const mk = normPricingKey(materialKey);
  const g = gaugeMmKeyFromLabel(gaugeLabel);
  const bid = String(branchId || '').trim();
  if (!mk || !g || !bid || !Array.isArray(rows)) return 0;
  let best = 0;
  for (const r of rows) {
    if (normPricingKey(r.materialKey) !== mk) continue;
    if (gaugeMmKeyFromLabel(r.gaugeMm) !== g) continue;
    if (String(r.branchId ?? '').trim() !== bid) continue;
    const list =
      Math.round(Number(r.publishedListPriceNgn) || 0) ||
      publishedListPriceFromWorkbook(r.minimumPricePerMeterNgn, r.commissionNgnPerM);
    if (list > best) best = list;
  }
  return best;
}

/**
 * Split a sheet ₦/m into trim strip ₦/m and add ridge add-on.
 * @param {number} basePerMeter
 * @param {number} girthMm
 * @param {number} addOnNgn
 */
function trimPerMeterFromSheetBase(basePerMeter, girthMm, addOnNgn) {
  const base = Number(basePerMeter) || 0;
  const girth = Number(girthMm);
  if (!(base > 0) || !Number.isFinite(girth) || girth <= 0 || girth > 1200) return 0;
  const segments = 1200 / girth;
  if (!Number.isFinite(segments) || segments <= 0) return 0;
  return roundPublishedPriceNgn(base / segments + Math.max(0, Number(addOnNgn) || 0));
}

/**
 * Floor + list ₦/m for a trim line from workbook sheet economics + ridge add-ons.
 * Floor uses workbook minimum ₦/m (+ internal add-on); list uses published/suggested list (+ customer list add-on).
 * @param {{
 *   materialPricingRows: object[],
 *   ridgeAddOns?: object[],
 *   materialKey: string,
 *   gaugeLabel: string,
 *   branchId: string,
 *   designLabel?: string,
 *   girthMm: number | string,
 * }} ctx
 * @returns {{ floorPerMeter: number; suggestedListPerMeter: number } | null}
 */
export function resolveTrimWorkbookMetaFromWorkbook(ctx) {
  const girth = Number(ctx?.girthMm);
  if (!Number.isFinite(girth) || girth <= 0 || girth > 1200) return null;

  const hit = resolveMaterialWorkbookPriceFromRows(ctx.materialPricingRows, {
    materialKey: ctx.materialKey,
    gaugeMm: ctx.gaugeLabel,
    branchId: ctx.branchId,
    designLabel: ctx.designLabel,
  });
  let listBase = hit?.suggestedListPerMeter || 0;
  if (!listBase) {
    listBase = maxPublishedListPerMeterForMatGauge(
      ctx.materialPricingRows,
      ctx.materialKey,
      ctx.gaugeLabel,
      ctx.branchId
    );
  }
  const floorBase = hit?.floorPerMeter || 0;
  if (!(listBase > 0) && !(floorBase > 0)) return null;

  const ridgeRow = ridgeMatchedAddOnRow(ctx.ridgeAddOns, ctx.materialKey, girth);
  const listAddOn = ridgeRow ? customerRidgeListAddOnNgn(ridgeRow) : 0;
  const floorAddOn = Math.max(0, Math.round(Number(ridgeRow?.addOnNgn) || 0));

  const suggestedListPerMeter = listBase > 0 ? trimPerMeterFromSheetBase(listBase, girth, listAddOn) : 0;
  let floorPerMeter = floorBase > 0 ? trimPerMeterFromSheetBase(floorBase, girth, floorAddOn) : 0;
  // When sheet floor is missing, list is the enforceable minimum (legacy trim gate).
  if (!(floorPerMeter > 0) && suggestedListPerMeter > 0) floorPerMeter = suggestedListPerMeter;
  if (!(floorPerMeter > 0) && !(suggestedListPerMeter > 0)) return null;
  return {
    floorPerMeter: floorPerMeter || suggestedListPerMeter,
    suggestedListPerMeter: suggestedListPerMeter || floorPerMeter,
  };
}

/**
 * Published list NGN/m for a trim line (ridge / flashing) at a strip width.
 * @param {{
 *   materialPricingRows: object[],
 *   ridgeAddOns?: object[],
 *   materialKey: string,
 *   gaugeLabel: string,
 *   branchId: string,
 *   designLabel?: string,
 *   girthMm: number | string,
 * }} ctx
 */
export function resolveTrimListPricePerMeterFromWorkbook(ctx) {
  return resolveTrimWorkbookMetaFromWorkbook(ctx)?.suggestedListPerMeter || 0;
}

/**
 * Below-floor violations for trim / flashing lines priced from the material workbook.
 * @param {{
 *   products?: object[],
 *   materialKey?: string,
 *   gaugeLabel?: string,
 *   branchId?: string,
 *   designLabel?: string,
 *   materialPricingRows?: object[],
 *   ridgeAddOns?: object[],
 * }} ctx
 */
export function quotationTrimWorkbookFloorViolations(ctx) {
  const products = Array.isArray(ctx?.products) ? ctx.products : [];
  const materialKey = String(ctx?.materialKey ?? '').trim();
  const gaugeLabel = String(ctx?.gaugeLabel ?? '').trim();
  const branchId = String(ctx?.branchId ?? '').trim();
  const designLabel = String(ctx?.designLabel ?? '').trim();
  const materialPricingRows = Array.isArray(ctx?.materialPricingRows) ? ctx.materialPricingRows : [];
  const ridgeAddOns = ctx?.ridgeAddOns;
  if (!materialKey || !gaugeLabel || !branchId || !materialPricingRows.length) return [];

  const violations = [];
  products.forEach((line, idx) => {
    if (!isQuotationTrimProductLine(line?.name)) return;
    const meters = quotationLineQtyNumber(line);
    if (meters <= 0) return;
    const girthMm = resolveTrimGirthMmForLine(line);
    const meta = resolveTrimWorkbookMetaFromWorkbook({
      materialPricingRows,
      ridgeAddOns,
      materialKey,
      gaugeLabel,
      branchId,
      designLabel,
      girthMm,
    });
    const floor = Number(meta?.floorPerMeter) || 0;
    if (floor <= 0) return;

    const unit = Number(line?.unitPrice ?? line?.unitPriceNgn ?? line?.pricePerMeter ?? 0) || 0;
    let effectivePerMeter = unit;
    if (effectivePerMeter <= 0 && meters > 0) {
      const total = Number(line?.lineTotalNgn ?? line?.totalNgn ?? line?.amountNgn ?? 0) || 0;
      if (total > 0) effectivePerMeter = total / meters;
    }
    if (effectivePerMeter <= 0) return;
    if (effectivePerMeter + 0.0001 < floor) {
      violations.push({
        // MD gate is workbook floor (+ ridge add-on). Selling below list but ≥ floor is allowed.
        code: 'below_floor',
        priceBasis: 'workbook_floor_plus_ridge',
        lineCategory: 'products',
        lineIndex: idx,
        lineName: String(line?.name ?? '').trim(),
        gauge: gaugeLabel,
        design: designLabel || `girth ${girthMm}mm`,
        girthMm,
        quotedPerMeter: Math.round(effectivePerMeter * 100) / 100,
        floorPerMeter: floor,
        minimumPerMeter: floor,
        recommendedPerMeter: Number(meta?.suggestedListPerMeter) || floor,
        trimWorkbook: true,
        message: 'Below trim workbook floor',
      });
    }
  });
  return violations;
}
