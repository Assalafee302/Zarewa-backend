/**
 * Trim / ridge list price from material pricing workbook + ridge add-on policy.
 * Keep frontend mirror in Zarewa-frontend-main/src/lib/materialWorkbookTrimPrice.js in sync.
 */

import {
  gaugeMmKeyFromLabel,
  normPricingKey,
  publishedListPriceFromWorkbook,
  resolveMaterialWorkbookPriceFromRows,
  roundPublishedPriceNgn,
} from './materialWorkbookQuotationPrice.js';

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
    if (String(r.gaugeMm ?? '').trim() !== g) continue;
    if (String(r.branchId ?? '').trim() !== bid) continue;
    const list =
      Math.round(Number(r.publishedListPriceNgn) || 0) ||
      publishedListPriceFromWorkbook(r.minimumPricePerMeterNgn, r.commissionNgnPerM);
    if (list > best) best = list;
  }
  return best;
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
  const girth = Number(ctx?.girthMm);
  if (!Number.isFinite(girth) || girth <= 0 || girth > 1200) return 0;

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
  if (!listBase) return 0;

  const segments = 1200 / girth;
  if (!Number.isFinite(segments) || segments <= 0) return 0;

  const ridgeRow = ridgeMatchedAddOnRow(ctx.ridgeAddOns, ctx.materialKey, girth);
  const addOn = ridgeRow ? customerRidgeListAddOnNgn(ridgeRow) : 0;
  return roundPublishedPriceNgn(listBase / segments + addOn);
}
