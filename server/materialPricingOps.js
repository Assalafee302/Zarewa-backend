import crypto from 'node:crypto';
import { roundConv2 } from '../shared/lib/conversionKgPerM.js';
import {
  MATERIAL_PRICING_STANDARD_GAUGES_MM,
  productIdForMaterialKey,
  theoreticalStandardKgPerM,
  catalogStandardKgPerMByGauge,
  isoDateDaysAgo,
  purchaseConversionMetaByGauge,
  gaugeHistoryConversionMetaByGauge,
  averageOfThreeConversions,
  avgMapFromMeta,
  resolveCoilConversionsForGauge,
  resolveCoilConversionsForAllGauges,
} from './materialPricingConversionResolve.js';
import { suggestedPricePerMeterNgn } from '../shared/lib/suggestedPricePerMeter.js';
import { appendAuditLog } from './controlOps.js';
import { upsertPriceListItem, defaultPriceListEffectiveFromIso } from './pricingOps.js';
import { listMaterialPricingRowsAsOf, normalizePricingAsAtIso } from './pricingAsOf.js';
import { STONE_COATED_GAUGES, roundPublishedPrice } from './pricingPolicyResolve.js';

export { roundConv2 } from '../shared/lib/conversionKgPerM.js';
export { suggestedPricePerMeterNgn } from '../shared/lib/suggestedPricePerMeter.js';
export {
  MATERIAL_PRICING_STANDARD_GAUGES_MM,
  productIdForMaterialKey,
  theoreticalStandardKgPerM,
  catalogStandardKgPerM,
  catalogStandardKgPerMByGauge,
  purchaseAvgConversionKgPerMByGauge,
  gaugeHistoryAvgConversionKgPerMByGauge,
  purchaseConversionMetaByGauge,
  gaugeHistoryConversionMetaByGauge,
  averageOfThreeConversions,
  avgMapFromMeta,
  resolveCoilConversionsForGauge,
  resolveCoilConversionsForAllGauges,
  usedConfidenceFromMeta,
} from './materialPricingConversionResolve.js';

/**
 * Weighted average landed unit cost (₦/kg) from coil GRNs in the last `days`, branch-scoped.
 * @returns {number | null}
 */
export function purchaseWeightedAvgCostPerKgLastDays(db, productId, branchId, days = 30) {
  const pid = String(productId || '').trim();
  const bid = String(branchId || '').trim();
  if (!pid || !bid) return null;
  let coilReady = false;
  try {
    coilReady = Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='coil_lots'`).get());
  } catch {
    try {
      coilReady = Boolean(
        db
          .prepare(
            `SELECT 1 AS ok FROM information_schema.tables
             WHERE table_schema = DATABASE() AND table_name = 'coil_lots'`
          )
          .get()
      );
    } catch {
      coilReady = false;
    }
  }
  if (!coilReady) return null;
  const since = isoDateDaysAgo(days);
  const rows = db
    .prepare(
      `SELECT unit_cost_ngn_per_kg, weight_kg, current_weight_kg, qty_received
       FROM coil_lots
       WHERE product_id = ?
         AND IFNULL(branch_id, '') = ?
         AND unit_cost_ngn_per_kg IS NOT NULL
         AND unit_cost_ngn_per_kg > 0
         AND received_at_iso IS NOT NULL
         AND SUBSTR(received_at_iso, 1, 10) >= ?`
    )
    .all(pid, bid, since);
  let sumW = 0;
  let sumCost = 0;
  for (const r of rows) {
    const uk = Number(r.unit_cost_ngn_per_kg);
    const w =
      Number(r.weight_kg) || Number(r.current_weight_kg) || Number(r.qty_received) || 0;
    if (!Number.isFinite(uk) || uk <= 0 || w <= 0) continue;
    sumW += w;
    sumCost += uk * w;
  }
  if (sumW <= 0) return null;
  return Math.round(sumCost / sumW);
}

/**
 * Branch coil purchase avg ₦/kg — recent receipts first, then all received lots with unit cost.
 * @returns {{ cost: number|null; source: string }}
 */
export function resolveBranchCoilCostPerKg(db, productId, branchId, days = 31) {
  const recent = purchaseWeightedAvgCostPerKgLastDays(db, productId, branchId, days);
  if (recent) return { cost: recent, source: `purchase_${days}d` };
  const pid = String(productId || '').trim();
  const bid = String(branchId || '').trim();
  if (!pid || !bid) return { cost: null, source: 'none' };
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='coil_lots'`).get()) {
    return { cost: null, source: 'none' };
  }
  const rows = db
    .prepare(
      `SELECT unit_cost_ngn_per_kg, weight_kg, current_weight_kg, qty_received
       FROM coil_lots
       WHERE product_id = ?
         AND IFNULL(branch_id, '') = ?
         AND unit_cost_ngn_per_kg IS NOT NULL
         AND unit_cost_ngn_per_kg > 0`
    )
    .all(pid, bid);
  let sumW = 0;
  let sumCost = 0;
  for (const r of rows) {
    const uk = Number(r.unit_cost_ngn_per_kg);
    const w = Number(r.weight_kg) || Number(r.current_weight_kg) || Number(r.qty_received) || 0;
    if (!Number.isFinite(uk) || uk <= 0 || w <= 0) continue;
    sumW += w;
    sumCost += uk * w;
  }
  if (sumW <= 0) return { cost: null, source: 'none' };
  return { cost: Math.round(sumCost / sumW), source: 'coil_lots_all' };
}

/**
 * Weighted avg unit price from GRN stock movements (positive qty) for a product in branch.
 * @returns {number|null}
 */
export function purchaseWeightedAvgUnitPriceLastDays(db, productId, branchId, days = 31) {
  const pid = String(productId || '').trim();
  const bid = String(branchId || '').trim();
  if (!pid) return null;
  const since = isoDateDaysAgo(days);
  /** @type {{ qty: number; unit_price_ngn: number }[]} */
  let rows = [];
  if (
    bid &&
    db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='purchase_orders'`).get()
  ) {
    rows = db
      .prepare(
        `SELECT sm.qty, sm.unit_price_ngn
         FROM stock_movements sm
         INNER JOIN purchase_orders po ON po.po_id = sm.ref
         WHERE sm.product_id = ?
           AND po.branch_id = ?
           AND sm.qty > 0
           AND sm.unit_price_ngn IS NOT NULL
           AND sm.unit_price_ngn > 0
           AND SUBSTR(COALESCE(sm.date_iso, sm.at_iso), 1, 10) >= ?`
      )
      .all(pid, bid, since);
  }
  if (!rows.length) {
    rows = db
      .prepare(
        `SELECT qty, unit_price_ngn FROM stock_movements
         WHERE product_id = ?
           AND qty > 0
           AND unit_price_ngn IS NOT NULL
           AND unit_price_ngn > 0
           AND SUBSTR(COALESCE(date_iso, at_iso), 1, 10) >= ?`
      )
      .all(pid, since);
  }
  let sumQ = 0;
  let sumVal = 0;
  for (const r of rows) {
    const q = Number(r.qty) || 0;
    const p = Number(r.unit_price_ngn) || 0;
    if (q <= 0 || p <= 0) continue;
    sumQ += q;
    sumVal += q * p;
  }
  if (sumQ <= 0) return null;
  return Math.round(sumVal / sumQ);
}

/**
 * Build productId → weighted avg unit price for products matching SQL LIKE pattern.
 * @returns {Map<string, number>}
 */
export function purchaseUnitPriceMapByProductPrefix(db, branchId, productIdLike, days = 31) {
  const bid = String(branchId || '').trim();
  const like = String(productIdLike || '').trim();
  const map = new Map();
  if (!like || !db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='products'`).get()) {
    return map;
  }
  const products = db.prepare(`SELECT product_id FROM products WHERE product_id LIKE ?`).all(like);
  for (const p of products) {
    const price = purchaseWeightedAvgUnitPriceLastDays(db, p.product_id, bid, days);
    if (price) map.set(String(p.product_id), price);
  }
  return map;
}

function normKey(s) {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function mapRow(row) {
  if (!row) return null;
  const std = row.conversion_standard_kg_per_m != null ? Number(row.conversion_standard_kg_per_m) : null;
  const ref = row.conversion_reference_kg_per_m != null ? Number(row.conversion_reference_kg_per_m) : null;
  const hist = row.conversion_history_kg_per_m != null ? Number(row.conversion_history_kg_per_m) : null;
  const used = row.conversion_used_kg_per_m != null ? Number(row.conversion_used_kg_per_m) : null;
  const avg = averageOfThreeConversions(std, ref, hist);
  const costKg = Number(row.cost_per_kg_ngn) || 0;
  const oh = Number(row.overhead_ngn_per_m) || 0;
  const pr = Number(row.profit_ngn_per_m) || 0;
  const suggested = suggestedPricePerMeterNgn(used, costKg, oh, pr);
  const minimum = Math.max(0, Math.round(Number(row.minimum_price_per_m_ngn) || 0));
  const commission = Math.max(0, Number(row.commission_ngn_per_m) || 0);
  const publishedListPriceNgn = roundPublishedPrice(minimum + commission);
  const syncMinimumToPriceList = Number(row.sync_minimum_to_price_list) === 1;
  const syncDesignKey = String(row.sync_design_key ?? '').trim();
  return {
    id: row.id,
    materialKey: row.material_key,
    gaugeMm: row.gauge_mm,
    branchId: row.branch_id,
    designKey: row.design_key ?? '',
    syncMinimumToPriceList,
    syncDesignKey,
    conversionStandardKgPerM: roundConv2(std),
    conversionReferenceKgPerM: roundConv2(ref),
    conversionHistoryKgPerM: roundConv2(hist),
    conversionAvgKgPerM: roundConv2(avg),
    conversionUsedKgPerM: roundConv2(used),
    costPerKgNgn: costKg,
    overheadNgnPerM: oh,
    profitNgnPerM: pr,
    suggestedPricePerMeterNgn: suggested,
    minimumPricePerMeterNgn: minimum,
    commissionNgnPerM: commission,
    publishedListPriceNgn,
    gaugeCustomerLabel: String(row.gauge_customer_label ?? '').trim().slice(0, 120),
    notes: row.notes ?? '',
    updatedAtIso: row.updated_at_iso ?? null,
    updatedByUserId: row.updated_by_user_id ?? null,
  };
}

/** Compact audit payload — enough for change log UI without full mapped rows. */
function compactPricingEventDiff(before, after) {
  return {
    beforeMin: before?.minimumPricePerMeterNgn ?? null,
    afterMin: after?.minimumPricePerMeterNgn ?? null,
    beforeUsed: before?.conversionUsedKgPerM ?? null,
    afterUsed: after?.conversionUsedKgPerM ?? null,
    beforeList: before?.publishedListPriceNgn ?? null,
    afterList: after?.publishedListPriceNgn ?? null,
    beforeCost: before?.costPerKgNgn ?? null,
    afterCost: after?.costPerKgNgn ?? null,
    beforeCommission: before?.commissionNgnPerM ?? null,
    afterCommission: after?.commissionNgnPerM ?? null,
    beforeSync: before?.syncMinimumToPriceList ?? null,
    afterSync: after?.syncMinimumToPriceList ?? null,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} materialKey
 * @param {string} branchId
 * @param {string | null | undefined} [asAtIso]
 */
export function listMaterialPricingSheet(db, materialKey, branchId, asAtIso) {
  const mk = normKey(materialKey);
  const bid = String(branchId || '').trim();
  if (!mk || (mk !== 'alu' && mk !== 'aluzinc' && mk !== 'stone-coated')) {
    return { ok: false, error: 'materialKey must be alu, aluzinc, or stone-coated.' };
  }
  if (!bid) return { ok: false, error: 'branchId is required.' };
  const isStone = mk === 'stone-coated';
  const gaugeList = isStone ? [...STONE_COATED_GAUGES] : [...MATERIAL_PRICING_STANDARD_GAUGES_MM];
  const pid = productIdForMaterialKey(mk);
  const since = isoDateDaysAgo(30);
  const purchaseMetaByGauge =
    pid && !isStone ? purchaseConversionMetaByGauge(db, pid, since, bid) : {};
  const historyMetaByGauge =
    pid && !isStone ? gaugeHistoryConversionMetaByGauge(db, pid, since, bid) : {};
  const purchaseAvgConversionByGauge = !isStone ? avgMapFromMeta(purchaseMetaByGauge) : {};
  const gaugeHistoryAvgConversionByGauge = !isStone ? avgMapFromMeta(historyMetaByGauge) : {};
  const catalogByGauge = pid && !isStone ? catalogStandardKgPerMByGauge(db, pid) : {};
  const recommendedCostPerKgNgn =
    pid && !isStone ? purchaseWeightedAvgCostPerKgLastDays(db, pid, bid, 30) : null;

  const theoreticalStandardByGauge = {};
  const catalogHintByGauge = {};
  if (!isStone) {
    for (const g of MATERIAL_PRICING_STANDARD_GAUGES_MM) {
      const mm = parseFloat(g, 10);
      const t = theoreticalStandardKgPerM(mk, mm);
      if (t != null) theoreticalStandardByGauge[g] = roundConv2(t) ?? t;
      const c = catalogByGauge[g];
      if (c != null && Number(c) > 0) catalogHintByGauge[g] = roundConv2(c) ?? c;
    }
  }

  const resolvedAll = !isStone
    ? resolveCoilConversionsForAllGauges(db, mk, {
        branchId: bid,
        gauges: gaugeList,
        purchaseMeta: purchaseMetaByGauge,
        histMeta: historyMetaByGauge,
        catalogByGauge,
      })
    : null;

  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='material_pricing_sheet_rows'`).get()) {
    /** @type {Record<string, object>} */
    const resolvedByGaugeEmpty = {};
    for (const g of gaugeList) {
      if (isStone) {
        resolvedByGaugeEmpty[g] = {
          std: null,
          ref: null,
          hist: null,
          usedSuggested: null,
          used: null,
          stdSource: null,
          refMeta: { avg: null, n: 0, lastAtIso: null },
          histMeta: { avg: null, n: 0, lastAtIso: null },
          usedConfidence: 'none',
        };
      } else {
        const base = resolvedAll[g];
        resolvedByGaugeEmpty[g] = { ...base, used: base.usedSuggested };
      }
    }
    return {
      ok: true,
      materialKey: mk,
      branchId: bid,
      gauges: gaugeList,
      theoreticalStandardByGauge,
      catalogHintByGauge,
      purchaseAvgConversionByGauge,
      gaugeHistoryAvgConversionByGauge,
      purchaseMetaByGauge,
      historyMetaByGauge,
      recommendedCostPerKgNgn,
      isStoneCoatedWorkbook: isStone,
      purchaseCostLookbackDays: 30,
      resolvedByGauge: resolvedByGaugeEmpty,
      rows: [],
    };
  }

  const dbRows = (() => {
    const asAt =
      asAtIso != null && String(asAtIso).trim() ? normalizePricingAsAtIso(asAtIso) : null;
    if (asAt) {
      return listMaterialPricingRowsAsOf(db, bid, asAt)
        .filter((r) => normKey(r.materialKey) === mk)
        .map((r) => ({
          id: r.id ?? `MPS-HIST-${mk}-${r.gaugeMm}-${r.designKey}`,
          materialKey: r.materialKey,
          gaugeMm: r.gaugeMm,
          branchId: r.branchId,
          designKey: r.designKey ?? '',
          syncMinimumToPriceList: false,
          syncDesignKey: '',
          conversionStandardKgPerM: null,
          conversionReferenceKgPerM: null,
          conversionHistoryKgPerM: null,
          conversionAvgKgPerM: null,
          conversionUsedKgPerM: null,
          costPerKgNgn: 0,
          overheadNgnPerM: 0,
          profitNgnPerM: 0,
          suggestedPricePerMeterNgn: null,
          minimumPricePerMeterNgn: r.minimumPricePerMeterNgn,
          commissionNgnPerM: r.commissionNgnPerM,
          publishedListPriceNgn: r.publishedListPriceNgn,
          gaugeCustomerLabel: '',
          notes: '',
          updatedAtIso: null,
          updatedByUserId: null,
          pricingAsAtIso: asAt,
        }));
    }
    return db
      .prepare(
        `SELECT * FROM material_pricing_sheet_rows
         WHERE material_key = ? AND branch_id = ?
         ORDER BY gauge_mm ASC, design_key ASC`
      )
      .all(mk, bid)
      .map((r) => mapRow(r));
  })();

  /** @type {Map<string, object>} */
  const rowByBlankDesignGauge = new Map();
  for (const r of dbRows) {
    if (!String(r.designKey || '').trim()) {
      rowByBlankDesignGauge.set(String(r.gaugeMm), r);
    }
  }

  /** @type {Record<string, object>} */
  const resolvedByGauge = {};
  for (const g of gaugeList) {
    if (isStone) {
      resolvedByGauge[g] = {
        std: null,
        ref: null,
        hist: null,
        usedSuggested: null,
        used: null,
        stdSource: null,
        refMeta: { avg: null, n: 0, lastAtIso: null },
        histMeta: { avg: null, n: 0, lastAtIso: null },
        usedConfidence: 'none',
      };
      continue;
    }
    const base = resolvedAll[g];
    const rowForGauge = rowByBlankDesignGauge.get(g);
    const stored = rowForGauge?.conversionUsedKgPerM;
    const storedNum =
      stored != null && Number.isFinite(Number(stored)) && Number(stored) > 0 ? Number(stored) : null;
    const usedEff = storedNum != null ? roundConv2(storedNum) : base.usedSuggested;
    resolvedByGauge[g] = {
      ...base,
      used: usedEff,
    };
  }

  return {
    ok: true,
    materialKey: mk,
    branchId: bid,
    pricingAsAtIso: asAtIso != null && String(asAtIso).trim() ? normalizePricingAsAtIso(asAtIso) : null,
    gauges: gaugeList,
    theoreticalStandardByGauge,
    catalogHintByGauge,
    purchaseAvgConversionByGauge,
    gaugeHistoryAvgConversionByGauge,
    purchaseMetaByGauge,
    historyMetaByGauge,
    recommendedCostPerKgNgn,
    isStoneCoatedWorkbook: isStone,
    purchaseCostLookbackDays: 30,
    resolvedByGauge,
    rows: dbRows,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ materialKey?: string; branchId?: string; limit?: number }} q
 */
export function listMaterialPricingEvents(db, q) {
  const mk = normKey(q?.materialKey);
  const bid = q?.branchId != null ? String(q.branchId).trim() : '';
  const limit = Math.min(200, Math.max(1, Math.round(Number(q?.limit) || 80)));
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='material_pricing_sheet_events'`).get()) {
    return { ok: true, events: [] };
  }
  if (!mk || (mk !== 'alu' && mk !== 'aluzinc' && mk !== 'stone-coated')) {
    return { ok: false, error: 'materialKey must be alu, aluzinc, or stone-coated.' };
  }
  const events = (
    bid
      ? db
          .prepare(
            `SELECT id, row_id, material_key, gauge_mm, branch_id, design_key, payload_json, changed_at_iso, changed_by_user_id, action
             FROM material_pricing_sheet_events
             WHERE material_key = ? AND branch_id = ?
             ORDER BY changed_at_iso DESC
             LIMIT ?`
          )
          .all(mk, bid, limit)
      : db
          .prepare(
            `SELECT id, row_id, material_key, gauge_mm, branch_id, design_key, payload_json, changed_at_iso, changed_by_user_id, action
             FROM material_pricing_sheet_events
             WHERE material_key = ?
             ORDER BY changed_at_iso DESC
             LIMIT ?`
          )
          .all(mk, limit)
  ).map((row) => ({
    id: row.id,
    rowId: row.row_id,
    materialKey: row.material_key,
    gaugeMm: row.gauge_mm,
    branchId: row.branch_id,
    designKey: row.design_key ?? '',
    payload: safeJson(row.payload_json),
    changedAtIso: row.changed_at_iso,
    changedByUserId: row.changed_by_user_id ?? null,
    action: row.action ?? 'upsert',
  }));
  return { ok: true, events };
}

function safeJson(raw) {
  try {
    return JSON.parse(String(raw || '{}'));
  } catch {
    return {};
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} body
 * @param {object} actor
 * @param {{ resolvedByGauge?: Record<string, object> }} [opts]
 */
export function upsertMaterialPricingSheetRow(db, body, actor, opts = {}) {
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='material_pricing_sheet_rows'`).get()) {
    return { ok: false, error: 'Pricing workbook tables are not available.' };
  }
  const materialKey = normKey(body?.materialKey);
  const gaugeMm = String(body?.gaugeMm ?? body?.gauge ?? '').trim();
  const branchId = String(body?.branchId ?? '').trim();
  const designKey = normKey(body?.designKey ?? '');
  if (!materialKey || (materialKey !== 'alu' && materialKey !== 'aluzinc' && materialKey !== 'stone-coated')) {
    return { ok: false, error: 'materialKey must be alu, aluzinc, or stone-coated.' };
  }
  if (!gaugeMm || gaugeMm.length > 32) return { ok: false, error: 'gaugeMm is required (max 32 chars).' };
  if (!branchId || branchId.length > 64) return { ok: false, error: 'branchId is required.' };
  if (designKey.length > 120) return { ok: false, error: 'designKey is too long.' };
  if (materialKey === 'stone-coated' && !STONE_COATED_GAUGES.includes(String(gaugeMm).trim())) {
    return { ok: false, error: `Stone-coated workbook only supports gauges: ${STONE_COATED_GAUGES.join(', ')}.` };
  }
  if (materialKey !== 'stone-coated') {
    const gm = String(gaugeMm).trim();
    if (!MATERIAL_PRICING_STANDARD_GAUGES_MM.includes(gm)) {
      return {
        ok: false,
        error: `Coil workbook gauge must be one of: ${MATERIAL_PRICING_STANDARD_GAUGES_MM.join(', ')}.`,
      };
    }
  }

  const gaugeCustomerLabel =
    body?.gaugeCustomerLabel != null ? String(body.gaugeCustomerLabel).trim().slice(0, 120) : '';

  const existing = db
    .prepare(
      `SELECT * FROM material_pricing_sheet_rows
       WHERE material_key = ? AND gauge_mm = ? AND branch_id = ? AND design_key = ?`
    )
    .get(materialKey, gaugeMm, branchId, designKey);

  const id =
    existing?.id ||
    String(body?.id || '').trim() ||
    `MPS-${crypto.randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;

  let std;
  let ref;
  let hist;
  let used;
  if (materialKey === 'stone-coated') {
    std = null;
    ref = null;
    hist = null;
    used = null;
  } else {
    const resolved = resolveCoilConversionsForGauge(db, materialKey, gaugeMm, {
      branchId,
      resolvedByGauge: opts.resolvedByGauge,
    });
    std = resolved.std;
    ref = resolved.ref;
    hist = resolved.hist;
    const suggested = resolved.usedSuggested;
    const hasKey = body != null && typeof body === 'object' && 'conversionUsedKgPerM' in body;
    if (hasKey) {
      const raw = body.conversionUsedKgPerM;
      if (raw === null || raw === undefined || raw === '') {
        used = suggested;
      } else {
        const n = Number(raw);
        used = Number.isFinite(n) && n > 0 ? roundConv2(n) : suggested;
      }
    } else {
      used = suggested;
    }
  }
  const costPerKg = Math.max(0, Number(body?.costPerKgNgn) || 0);
  const overhead = Math.max(0, Number(body?.overheadNgnPerM) || 0);
  const profit = Math.max(0, Number(body?.profitNgnPerM) || 0);
  const minimum = Math.max(0, Math.round(Number(body?.minimumPricePerMeterNgn) || 0));
  const commission = Math.max(0, Number(body?.commissionNgnPerM) || 0);
  const notes = body?.notes != null ? String(body.notes).trim().slice(0, 2000) : '';
  const syncMinimumToPriceList = body?.syncMinimumToPriceList ? 1 : 0;
  let syncDesignKeyStored = normKey(body?.syncDesignKey ?? body?.priceListDesignKey ?? '');
  if (materialKey === 'stone-coated' && !syncDesignKeyStored) {
    syncDesignKeyStored = 'stone-coated';
  }
  syncDesignKeyStored = syncDesignKeyStored.slice(0, 120);

  const now = new Date().toISOString();
  const before = existing ? mapRow(existing) : null;

  if (existing) {
    db.prepare(
      `UPDATE material_pricing_sheet_rows SET
        conversion_standard_kg_per_m = ?, conversion_reference_kg_per_m = ?, conversion_history_kg_per_m = ?,
        conversion_used_kg_per_m = ?, cost_per_kg_ngn = ?, overhead_ngn_per_m = ?, profit_ngn_per_m = ?,
        minimum_price_per_m_ngn = ?, commission_ngn_per_m = ?, gauge_customer_label = ?, notes = ?,
        sync_minimum_to_price_list = ?, sync_design_key = ?, updated_at_iso = ?, updated_by_user_id = ?
       WHERE id = ?`
    ).run(
      std,
      ref,
      hist,
      used,
      costPerKg,
      overhead,
      profit,
      minimum,
      commission,
      gaugeCustomerLabel || null,
      notes || null,
      syncMinimumToPriceList,
      syncDesignKeyStored,
      now,
      actor?.id ?? null,
      id
    );
  } else {
    db.prepare(
      `INSERT INTO material_pricing_sheet_rows (
        id, material_key, gauge_mm, branch_id, design_key,
        conversion_standard_kg_per_m, conversion_reference_kg_per_m, conversion_history_kg_per_m,
        conversion_used_kg_per_m, cost_per_kg_ngn, overhead_ngn_per_m, profit_ngn_per_m,
        minimum_price_per_m_ngn, commission_ngn_per_m, gauge_customer_label, notes,
        sync_minimum_to_price_list, sync_design_key, updated_at_iso, updated_by_user_id
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      id,
      materialKey,
      gaugeMm,
      branchId,
      designKey,
      std,
      ref,
      hist,
      used,
      costPerKg,
      overhead,
      profit,
      minimum,
      commission,
      gaugeCustomerLabel || null,
      notes || null,
      syncMinimumToPriceList,
      syncDesignKeyStored,
      now,
      actor?.id ?? null
    );
  }

  const afterRow = db.prepare(`SELECT * FROM material_pricing_sheet_rows WHERE id = ?`).get(id);
  const after = mapRow(afterRow);

  const evId = `MPSE-${crypto.randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
  db.prepare(
    `INSERT INTO material_pricing_sheet_events (
      id, row_id, material_key, gauge_mm, branch_id, design_key, payload_json, changed_at_iso, changed_by_user_id, action
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(
    evId,
    id,
    materialKey,
    gaugeMm,
    branchId,
    designKey,
    JSON.stringify(compactPricingEventDiff(before, after)),
    now,
    actor?.id ?? null,
    'upsert'
  );

  appendAuditLog(db, {
    actor,
    action: 'pricing.material_sheet_upsert',
    entityKind: 'material_pricing_sheet_row',
    entityId: id,
    note: `${materialKey} · ${gaugeMm} mm · ${branchId}`,
  });

  // Draft save only — price list updates go through publishMaterialPricingSheet.
  return { ok: true, id, row: after, priceListSync: null };
}

/**
 * Bulk upsert workbook rows in one transaction; resolve conversions once per material/branch.
 * @param {import('better-sqlite3').Database} db
 * @param {{ materialKey?: string; branchId?: string; rows?: object[] }} body
 * @param {object} actor
 */
export function upsertMaterialPricingSheetRowsBulk(db, body, actor) {
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='material_pricing_sheet_rows'`).get()) {
    return { ok: false, error: 'Pricing workbook tables are not available.', saved: [], errors: [] };
  }
  const materialKey = normKey(body?.materialKey);
  const branchId = String(body?.branchId ?? '').trim();
  const rows = Array.isArray(body?.rows) ? body.rows : [];
  if (!materialKey || (materialKey !== 'alu' && materialKey !== 'aluzinc' && materialKey !== 'stone-coated')) {
    return { ok: false, error: 'materialKey must be alu, aluzinc, or stone-coated.', saved: [], errors: [] };
  }
  if (!branchId) return { ok: false, error: 'branchId is required.', saved: [], errors: [] };
  if (!rows.length) return { ok: false, error: 'rows array is required.', saved: [], errors: [] };

  const resolvedByGauge =
    materialKey === 'stone-coated'
      ? {}
      : resolveCoilConversionsForAllGauges(db, materialKey, { branchId });

  /** @type {object[]} */
  const saved = [];
  /** @type {{ index: number; error: string }[]} */
  const errors = [];

  const runAll = db.transaction(() => {
    for (let i = 0; i < rows.length; i++) {
      const rowBody = { ...(rows[i] || {}), materialKey, branchId };
      const r = upsertMaterialPricingSheetRow(db, rowBody, actor, { resolvedByGauge });
      if (r.ok) {
        saved.push(r.row);
      } else {
        errors.push({ index: i, error: r.error || 'Save failed.' });
      }
    }
  });

  try {
    runAll();
  } catch (e) {
    return {
      ok: false,
      error: e?.message || 'Bulk upsert failed.',
      saved: [],
      errors: [{ index: -1, error: e?.message || 'Bulk upsert failed.' }],
    };
  }

  return {
    ok: errors.length === 0,
    saved,
    errors,
    error: errors.length ? `${errors.length} row(s) failed to save.` : undefined,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} rowId
 * @param {object} actor
 */
export function deleteMaterialPricingSheetRow(db, rowId, actor) {
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='material_pricing_sheet_rows'`).get()) {
    return { ok: false, error: 'Pricing workbook tables are not available.' };
  }
  const id = String(rowId || '').trim();
  if (!id) return { ok: false, error: 'Row id is required.' };
  const existing = db.prepare(`SELECT * FROM material_pricing_sheet_rows WHERE id = ?`).get(id);
  if (!existing) return { ok: false, error: 'Row not found.' };
  const before = mapRow(existing);
  const now = new Date().toISOString();
  db.prepare(`DELETE FROM material_pricing_sheet_rows WHERE id = ?`).run(id);

  if (db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='material_pricing_sheet_events'`).get()) {
    const evId = `MPSE-${crypto.randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
    db.prepare(
      `INSERT INTO material_pricing_sheet_events (
        id, row_id, material_key, gauge_mm, branch_id, design_key, payload_json, changed_at_iso, changed_by_user_id, action
      ) VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(
      evId,
      id,
      existing.material_key,
      existing.gauge_mm,
      existing.branch_id,
      existing.design_key ?? '',
      JSON.stringify(compactPricingEventDiff(before, null)),
      now,
      actor?.id ?? null,
      'delete'
    );
  }

  appendAuditLog(db, {
    actor,
    action: 'pricing.material_sheet_delete',
    entityKind: 'material_pricing_sheet_row',
    entityId: id,
    note: `${existing.material_key} · ${existing.gauge_mm} mm · ${existing.branch_id}`,
  });
  return { ok: true };
}

/**
 * Explicit publish: upsert price_list_items for workbook rows marked syncMinimumToPriceList
 * (or for explicit row ids). Does not change draft sheet economics.
 * @param {import('better-sqlite3').Database} db
 * @param {{ materialKey?: string; branchId?: string; rowIds?: string[]; effectiveFromIso?: string }} body
 * @param {object} actor
 */
export function publishMaterialPricingSheet(db, body, actor) {
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='material_pricing_sheet_rows'`).get()) {
    return { ok: false, error: 'Pricing workbook tables are not available.' };
  }
  const materialKey = normKey(body?.materialKey);
  const branchId = String(body?.branchId ?? '').trim();
  if (!materialKey || (materialKey !== 'alu' && materialKey !== 'aluzinc' && materialKey !== 'stone-coated')) {
    return { ok: false, error: 'materialKey must be alu, aluzinc, or stone-coated.' };
  }
  if (!branchId) return { ok: false, error: 'branchId is required.' };

  const idList = Array.isArray(body?.rowIds)
    ? body.rowIds.map((x) => String(x || '').trim()).filter(Boolean)
    : [];

  let rows;
  if (idList.length) {
    const placeholders = idList.map(() => '?').join(',');
    rows = db
      .prepare(
        `SELECT * FROM material_pricing_sheet_rows
         WHERE material_key = ? AND branch_id = ? AND id IN (${placeholders})`
      )
      .all(materialKey, branchId, ...idList);
  } else {
    rows = db
      .prepare(
        `SELECT * FROM material_pricing_sheet_rows
         WHERE material_key = ? AND branch_id = ? AND sync_minimum_to_price_list = 1`
      )
      .all(materialKey, branchId);
  }

  if (!rows.length) {
    return { ok: false, error: 'No workbook rows selected for publish (tick Include in publish).' };
  }

  const published = [];
  const errors = [];
  for (const raw of rows) {
    const row = mapRow(raw);
    const listPrice = Number(row.publishedListPriceNgn) || 0;
    if (listPrice <= 0) {
      errors.push({ id: row.id, gaugeMm: row.gaugeMm, error: 'List price must be > 0.' });
      continue;
    }
    let syncDesign = String(row.syncDesignKey || '').trim();
    if (materialKey === 'stone-coated') syncDesign = syncDesign || 'stone-coated';
    if (!syncDesign) {
      errors.push({ id: row.id, gaugeMm: row.gaugeMm, error: 'syncDesignKey is required to publish.' });
      continue;
    }
    const plId = `PL-MPS-${String(row.id).replace(/^MPS-/i, '').slice(0, 16)}`;
    const mtKey = materialKey === 'stone-coated' ? 'stone-coated' : materialKey;
    const pl = upsertPriceListItem(
      db,
      {
        id: plId,
        gaugeKey: row.gaugeMm,
        designKey: syncDesign,
        unitPricePerMeterNgn: listPrice,
        branchId,
        // Local calendar day when body omits effectiveFromIso (same default as upsertPriceListItem).
        effectiveFromIso:
          String(body?.effectiveFromIso || '').trim().slice(0, 10) ||
          defaultPriceListEffectiveFromIso(),
        notes: `Published from material pricing workbook (${materialKey}): floor + commission.`,
        materialTypeKey: mtKey,
      },
      actor
    );
    if (!pl?.ok) {
      errors.push({ id: row.id, gaugeMm: row.gaugeMm, error: pl?.error || 'Price list upsert failed.' });
      continue;
    }
    published.push({
      rowId: row.id,
      gaugeMm: row.gaugeMm,
      designKey: syncDesign,
      floorNgn: row.minimumPricePerMeterNgn,
      listNgn: listPrice,
      priceListId: pl.id || plId,
    });
  }

  appendAuditLog(db, {
    actor,
    action: 'pricing.material_sheet_publish',
    entityKind: 'material_pricing_sheet',
    entityId: `${materialKey}:${branchId}`,
    note: `Published ${published.length} row(s); ${errors.length} error(s)`,
  });

  return {
    ok: errors.length === 0,
    published,
    errors,
    error: errors.length ? `${errors.length} row(s) failed to publish.` : undefined,
  };
}
