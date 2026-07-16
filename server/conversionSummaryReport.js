/**
 * Period conversion summary by material × gauge for reports Excel export.
 * Columns: material, gauge, standard, history, purchase avg, average of 3, margin (₦/m).
 */
import {
  MATERIAL_PRICING_STANDARD_GAUGES_MM,
  averageOfThreeConversions,
  catalogStandardKgPerMByGauge,
  gaugeHistoryConversionMetaByGauge,
  productIdForMaterialKey,
  purchaseConversionMetaByGauge,
  resolveCoilConversionsForAllGauges,
} from './materialPricingConversionResolve.js';
import { roundConv2 } from '../shared/lib/conversionKgPerM.js';

const MATERIALS = [
  { key: 'alu', label: 'Aluminium' },
  { key: 'aluzinc', label: 'Aluzinc' },
];

function tableExists(db, name) {
  try {
    return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(String(name || '')));
  } catch {
    return false;
  }
}

/**
 * Profit/margin ₦/m from pricing sheet blank-design rows (current workbook values).
 * @param {import('better-sqlite3').Database} db
 * @param {string} materialKey
 * @param {string | null} branchId
 * @returns {Record<string, number | null>}
 */
function marginByGaugeFromPricingSheet(db, materialKey, branchId) {
  /** @type {Record<string, number | null>} */
  const out = {};
  const mk = String(materialKey || '').trim().toLowerCase();
  const bid = branchId && String(branchId).trim() && String(branchId).trim() !== 'ALL' ? String(branchId).trim() : null;
  if (!mk || !bid || !tableExists(db, 'material_pricing_sheet_rows')) return out;
  const rows = db
    .prepare(
      `SELECT gauge_mm, profit_ngn_per_m FROM material_pricing_sheet_rows
       WHERE material_key = ? AND branch_id = ?
         AND TRIM(IFNULL(design_key, '')) = ''`
    )
    .all(mk, bid);
  for (const r of rows) {
    const g = String(r.gauge_mm ?? '').trim();
    if (!g) continue;
    const pr = Number(r.profit_ngn_per_m);
    out[g] = Number.isFinite(pr) ? pr : null;
  }
  return out;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   startDate: string;
 *   endDate: string;
 *   branchId?: string | null;
 * }} opts
 */
export function buildConversionSummaryReport(db, opts) {
  const startDate = String(opts?.startDate || '').slice(0, 10);
  const endDate = String(opts?.endDate || '').slice(0, 10);
  const rawBid = opts?.branchId != null ? String(opts.branchId).trim() : '';
  const branchId = rawBid && rawBid !== 'ALL' ? rawBid : null;

  /** @type {Array<{
   *   material: string;
   *   materialKey: string;
   *   gauge: string;
   *   standardConversion: number | null;
   *   historyConversion: number | null;
   *   averagePurchaseConversion: number | null;
   *   averageOfThreeConversions: number | null;
   *   marginNgnPerM: number | null;
   *   purchaseSampleCount: number;
   *   historySampleCount: number;
   * }>} */
  const rows = [];

  for (const mat of MATERIALS) {
    const pid = productIdForMaterialKey(mat.key);
    if (!pid) continue;
    const purchaseMeta = purchaseConversionMetaByGauge(db, pid, startDate || null, branchId, endDate || null);
    const histMeta = gaugeHistoryConversionMetaByGauge(db, pid, startDate || null, branchId, endDate || null);
    const catalogByGauge = catalogStandardKgPerMByGauge(db, pid);
    const resolved = resolveCoilConversionsForAllGauges(db, mat.key, {
      branchId,
      gauges: [...MATERIAL_PRICING_STANDARD_GAUGES_MM],
      purchaseMeta,
      histMeta,
      catalogByGauge,
    });
    const marginByGauge = marginByGaugeFromPricingSheet(db, mat.key, branchId);

    for (const gauge of MATERIAL_PRICING_STANDARD_GAUGES_MM) {
      const r = resolved[gauge] || {};
      const std = r.std != null ? roundConv2(r.std) ?? r.std : null;
      const hist = r.hist != null ? roundConv2(r.hist) ?? r.hist : null;
      const purchase = r.ref != null ? roundConv2(r.ref) ?? r.ref : null;
      const avg3 =
        r.usedSuggested != null
          ? roundConv2(r.usedSuggested) ?? r.usedSuggested
          : roundConv2(averageOfThreeConversions(std, purchase, hist));
      const purchaseN = Number(purchaseMeta[gauge]?.n) || 0;
      const historyN = Number(histMeta[gauge]?.n) || 0;
      const hasPeriodActivity = purchaseN > 0 || historyN > 0;
      // Always include gauges with period purchase/history; also include when standard exists
      // so the sheet is a complete material×gauge matrix for the period review.
      if (!hasPeriodActivity && std == null) continue;

      rows.push({
        material: mat.label,
        materialKey: mat.key,
        gauge,
        standardConversion: std,
        historyConversion: hist,
        averagePurchaseConversion: purchase,
        averageOfThreeConversions: avg3,
        marginNgnPerM: marginByGauge[gauge] ?? null,
        purchaseSampleCount: purchaseN,
        historySampleCount: historyN,
      });
    }
  }

  return {
    startDate,
    endDate,
    branchId,
    rows,
  };
}

/** Excel-friendly flat rows with the column headers the user requested. */
export function conversionSummaryExcelRows(report) {
  return (report?.rows || []).map((r) => ({
    Material: r.material,
    Gauge: r.gauge,
    'Standard conversion': r.standardConversion ?? '',
    'History conversion': r.historyConversion ?? '',
    'Average purchase conversion': r.averagePurchaseConversion ?? '',
    'Average of the 3 conversions': r.averageOfThreeConversions ?? '',
    Margin: r.marginNgnPerM ?? '',
  }));
}
