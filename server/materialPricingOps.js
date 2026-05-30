import crypto from 'node:crypto';
import { roundConv2 } from '../shared/lib/conversionKgPerM.js';
import { appendAuditLog } from './controlOps.js';
import { upsertPriceListItem } from './pricingOps.js';
import { STONE_COATED_GAUGES, roundPublishedPrice } from './pricingPolicyResolve.js';

export { roundConv2 } from '../shared/lib/conversionKgPerM.js';

/** @type {readonly string[]} */
export const MATERIAL_PRICING_STANDARD_GAUGES_MM = [
  '0.18',
  '0.20',
  '0.22',
  '0.24',
  '0.28',
  '0.30',
  '0.40',
  '0.45',
  '0.50',
  '0.55',
  '0.70',
];

const STRIP_WIDTH_M = 1.2;
const DENSITY_ALU = 2.7 * 1000;
const DENSITY_ALUZINC = 7.8 * 1000;

/** @param {string} materialKey */
export function productIdForMaterialKey(materialKey) {
  const k = String(materialKey || '').trim().toLowerCase();
  if (k === 'alu') return 'COIL-ALU';
  if (k === 'aluzinc') return 'PRD-102';
  return '';
}

/**
 * @param {string} materialKey
 * @param {number} gaugeMm
 */
export function theoreticalStandardKgPerM(materialKey, gaugeMm) {
  const k = String(materialKey || '').trim().toLowerCase();
  const rho = k === 'alu' ? DENSITY_ALU : k === 'aluzinc' ? DENSITY_ALUZINC : null;
  if (rho == null || !Number.isFinite(gaugeMm) || gaugeMm <= 0) return null;
  return rho * STRIP_WIDTH_M * (gaugeMm / 1000);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} productId
 * @param {string} gaugeMm
 * @returns {number | null}
 */
export function catalogStandardKgPerM(db, productId, gaugeMm) {
  if (!productId || !gaugeMm) return null;
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='procurement_catalog'`).get()) {
    return null;
  }
  const rows = db
    .prepare(
      `SELECT conversion_kg_per_m FROM procurement_catalog
       WHERE product_id = ? AND TRIM(gauge) = TRIM(?) AND conversion_kg_per_m > 0`
    )
    .all(productId, String(gaugeMm).trim());
  if (!rows.length) return null;
  const sum = rows.reduce((s, r) => s + (Number(r.conversion_kg_per_m) || 0), 0);
  const v = sum / rows.length;
  return v > 0 ? v : null;
}

function isoDateDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - Math.max(1, Math.round(Number(days) || 30)));
  return d.toISOString().slice(0, 10);
}

/** Match productionTraceability gauge parsing for workbook hints. */
function parseGaugeMmFromLabel(value) {
  const match = String(value ?? '')
    .replace(/,/g, '.')
    .match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const next = Number(match[1]);
  return Number.isFinite(next) && next > 0 ? next : null;
}

/** Map a thickness in mm to a standard workbook gauge key, or null. */
function standardGaugeKeyForMm(mm) {
  if (!Number.isFinite(mm) || mm <= 0) return null;
  for (const g of MATERIAL_PRICING_STANDARD_GAUGES_MM) {
    if (Math.abs(parseFloat(g, 10) - mm) < 1e-4) return g;
  }
  return null;
}

/**
 * Mean supplier kg/m on received coils for this product, grouped by standard gauge key.
 * Optionally restricted to lots received on/after `sinceIso` (YYYY-MM-DD).
 * @param {import('better-sqlite3').Database} db
 * @param {string} productId
 * @param {string | null} sinceIso
 * @returns {Record<string, number>}
 */
export function purchaseAvgConversionKgPerMByGauge(db, productId, sinceIso = null) {
  const out = {};
  const pid = String(productId || '').trim();
  if (!pid) return out;
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='coil_lots'`).get()) return out;
  const since = sinceIso && String(sinceIso).trim().length >= 10 ? String(sinceIso).trim().slice(0, 10) : null;
  const rows = since
    ? db
        .prepare(
          `SELECT gauge_label, supplier_conversion_kg_per_m FROM coil_lots
           WHERE product_id = ?
             AND supplier_conversion_kg_per_m IS NOT NULL
             AND supplier_conversion_kg_per_m > 0
             AND received_at_iso IS NOT NULL
             AND SUBSTR(received_at_iso, 1, 10) >= ?`
        )
        .all(pid, since)
    : db
        .prepare(
          `SELECT gauge_label, supplier_conversion_kg_per_m FROM coil_lots
           WHERE product_id = ?
             AND supplier_conversion_kg_per_m IS NOT NULL
             AND supplier_conversion_kg_per_m > 0`
        )
        .all(pid);
  /** @type {Record<string, number[]>} */
  const buckets = {};
  for (const r of rows) {
    const mm = parseGaugeMmFromLabel(r.gauge_label);
    const key = standardGaugeKeyForMm(mm);
    if (!key) continue;
    const v = Number(r.supplier_conversion_kg_per_m);
    if (!Number.isFinite(v) || v <= 0) continue;
    if (!buckets[key]) buckets[key] = [];
    buckets[key].push(v);
  }
  for (const g of Object.keys(buckets)) {
    const vals = buckets[g];
    if (!vals.length) continue;
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    if (Number.isFinite(avg) && avg > 0) out[g] = avg;
  }
  return out;
}

/**
 * Mean posted actual kg/m from production conversion checks for this product’s coils, by standard gauge key.
 * @param {import('better-sqlite3').Database} db
 * @param {string} productId
 * @param {string | null} sinceIso — if set, only checks with checked_at_iso on/after this date (YYYY-MM-DD).
 * @returns {Record<string, number>}
 */
export function gaugeHistoryAvgConversionKgPerMByGauge(db, productId, sinceIso = null) {
  const out = {};
  const pid = String(productId || '').trim();
  if (!pid) return out;
  if (
    !db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='production_conversion_checks'`).get() ||
    !db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='coil_lots'`).get()
  ) {
    return out;
  }
  const since = sinceIso && String(sinceIso).trim().length >= 10 ? String(sinceIso).trim().slice(0, 10) : null;
  const rows = since
    ? db
        .prepare(
          `SELECT c.gauge_label, c.actual_conversion_kg_per_m
           FROM production_conversion_checks c
           INNER JOIN coil_lots cl ON cl.coil_no = c.coil_no
           WHERE cl.product_id = ?
             AND c.actual_conversion_kg_per_m IS NOT NULL
             AND c.actual_conversion_kg_per_m > 0
             AND c.checked_at_iso IS NOT NULL
             AND SUBSTR(c.checked_at_iso, 1, 10) >= ?`
        )
        .all(pid, since)
    : db
        .prepare(
          `SELECT c.gauge_label, c.actual_conversion_kg_per_m
           FROM production_conversion_checks c
           INNER JOIN coil_lots cl ON cl.coil_no = c.coil_no
           WHERE cl.product_id = ?
             AND c.actual_conversion_kg_per_m IS NOT NULL
             AND c.actual_conversion_kg_per_m > 0`
        )
        .all(pid);
  /** @type {Record<string, number[]>} */
  const buckets = {};
  for (const r of rows) {
    const mm = parseGaugeMmFromLabel(r.gauge_label);
    const key = standardGaugeKeyForMm(mm);
    if (!key) continue;
    const v = Number(r.actual_conversion_kg_per_m);
    if (!Number.isFinite(v) || v <= 0) continue;
    if (!buckets[key]) buckets[key] = [];
    buckets[key].push(v);
  }
  for (const g of Object.keys(buckets)) {
    const vals = buckets[g];
    if (!vals.length) continue;
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    if (Number.isFinite(avg) && avg > 0) out[g] = avg;
  }
  return out;
}

/**
 * @param {number | null | undefined} a
 * @param {number | null | undefined} b
 * @param {number | null | undefined} c
 * @returns {number | null}
 */
export function averageOfThreeConversions(a, b, c) {
  const vals = [a, b, c].filter((x) => x != null && Number.isFinite(Number(x)) && Number(x) > 0).map(Number);
  if (!vals.length) return null;
  return vals.reduce((s, x) => s + x, 0) / vals.length;
}

/**
 * Weighted average landed unit cost (₦/kg) from coil GRNs in the last `days`, branch-scoped.
 * @returns {number | null}
 */
export function purchaseWeightedAvgCostPerKgLastDays(db, productId, branchId, days = 30) {
  const pid = String(productId || '').trim();
  const bid = String(branchId || '').trim();
  if (!pid || !bid) return null;
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='coil_lots'`).get()) return null;
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
 * Data-driven kg/m conversions (2 dp): std = theory/catalog, ref = purchases (30d), hist = production checks (30d), usedSuggested = avg.
 */
export function resolveCoilConversionsForGauge(db, materialKey, gaugeMm) {
  const mk = normKey(materialKey);
  if (mk === 'stone-coated') {
    return { std: null, ref: null, hist: null, usedSuggested: null };
  }
  const pid = productIdForMaterialKey(mk);
  if (!pid) return { std: null, ref: null, hist: null, usedSuggested: null };
  const since = isoDateDaysAgo(30);
  const mm = parseFloat(String(gaugeMm));
  const th = theoreticalStandardKgPerM(mk, mm);
  const cat = catalogStandardKgPerM(db, pid, String(gaugeMm).trim());
  const stdRaw = th ?? cat ?? null;
  const purchaseMap = purchaseAvgConversionKgPerMByGauge(db, pid, since);
  const refRaw = purchaseMap[String(gaugeMm).trim()] ?? null;
  const histMap = gaugeHistoryAvgConversionKgPerMByGauge(db, pid, since);
  const histRaw = histMap[String(gaugeMm).trim()] ?? null;
  const std = roundConv2(stdRaw);
  const ref = roundConv2(refRaw);
  const hist = roundConv2(histRaw);
  const usedRaw = averageOfThreeConversions(std, ref, hist);
  const usedSuggested = roundConv2(usedRaw);
  return { std, ref, hist, usedSuggested };
}

/**
 * @param {number | null | undefined} convUsed
 * @param {number | null | undefined} costPerKg
 * @param {number | null | undefined} overheadPerM
 * @param {number | null | undefined} profitPerM
 * @returns {number | null}
 */
export function suggestedPricePerMeterNgn(convUsed, costPerKg, overheadPerM, profitPerM) {
  const u = Number(convUsed);
  const ck = Number(costPerKg);
  const oh = Number(overheadPerM) || 0;
  const pr = Number(profitPerM) || 0;
  if (!Number.isFinite(u) || u <= 0 || !Number.isFinite(ck) || ck < 0) return null;
  const base = u * ck;
  return Math.round(base + oh + pr);
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

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} materialKey
 * @param {string} branchId
 */
export function listMaterialPricingSheet(db, materialKey, branchId) {
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
  const purchaseAvgConversionByGauge =
    pid && !isStone ? purchaseAvgConversionKgPerMByGauge(db, pid, since) : {};
  const gaugeHistoryAvgConversionByGauge =
    pid && !isStone ? gaugeHistoryAvgConversionKgPerMByGauge(db, pid, since) : {};
  const recommendedCostPerKgNgn =
    pid && !isStone ? purchaseWeightedAvgCostPerKgLastDays(db, pid, bid, 30) : null;

  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='material_pricing_sheet_rows'`).get()) {
    /** @type {Record<string, { std: number | null; ref: number | null; hist: number | null; usedSuggested: number | null; used: number | null }>} */
    const resolvedByGaugeEmpty = {};
    for (const g of gaugeList) {
      if (isStone) {
        resolvedByGaugeEmpty[g] = { std: null, ref: null, hist: null, usedSuggested: null, used: null };
      } else {
        const base = resolveCoilConversionsForGauge(db, mk, g);
        const us = base.usedSuggested;
        resolvedByGaugeEmpty[g] = { ...base, used: us };
      }
    }
    return {
      ok: true,
      materialKey: mk,
      branchId: bid,
      gauges: gaugeList,
      theoreticalStandardByGauge: {},
      catalogHintByGauge: {},
      purchaseAvgConversionByGauge,
      gaugeHistoryAvgConversionByGauge,
      recommendedCostPerKgNgn,
      isStoneCoatedWorkbook: isStone,
      purchaseCostLookbackDays: 30,
      resolvedByGauge: resolvedByGaugeEmpty,
      rows: [],
    };
  }
  const theoreticalStandardByGauge = {};
  const catalogHintByGauge = {};
  if (!isStone) {
    for (const g of MATERIAL_PRICING_STANDARD_GAUGES_MM) {
      const mm = parseFloat(g, 10);
      const t = theoreticalStandardKgPerM(mk, mm);
      if (t != null) theoreticalStandardByGauge[g] = roundConv2(t) ?? t;
      const c = catalogStandardKgPerM(db, pid, g);
      if (c != null) catalogHintByGauge[g] = roundConv2(c) ?? c;
    }
  }
  const dbRows = db
    .prepare(
      `SELECT * FROM material_pricing_sheet_rows
       WHERE material_key = ? AND branch_id = ?
       ORDER BY gauge_mm ASC, design_key ASC`
    )
    .all(mk, bid)
    .map((r) => mapRow(r));

  /** @type {Record<string, { std: number | null; ref: number | null; hist: number | null; usedSuggested: number | null; used: number | null }>} */
  const resolvedByGauge = {};
  for (const g of gaugeList) {
    if (isStone) {
      resolvedByGauge[g] = { std: null, ref: null, hist: null, usedSuggested: null, used: null };
      continue;
    }
    const base = resolveCoilConversionsForGauge(db, mk, g);
    const rowForGauge = dbRows.find((r) => r.gaugeMm === g && !String(r.designKey || '').trim());
    const stored = rowForGauge?.conversionUsedKgPerM;
    const storedNum =
      stored != null && Number.isFinite(Number(stored)) && Number(stored) > 0 ? Number(stored) : null;
    const usedEff = storedNum != null ? roundConv2(storedNum) : base.usedSuggested;
    resolvedByGauge[g] = {
      std: base.std,
      ref: base.ref,
      hist: base.hist,
      usedSuggested: base.usedSuggested,
      used: usedEff,
    };
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
    recommendedCostPerKgNgn,
    isStoneCoatedWorkbook: isStone,
    purchaseCostLookbackDays: 30,
    resolvedByGauge,
    rows: dbRows,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ materialKey?: string; limit?: number }} q
 */
export function listMaterialPricingEvents(db, q) {
  const mk = normKey(q?.materialKey);
  const limit = Math.min(200, Math.max(1, Math.round(Number(q?.limit) || 80)));
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='material_pricing_sheet_events'`).get()) {
    return { ok: true, events: [] };
  }
  if (!mk || (mk !== 'alu' && mk !== 'aluzinc' && mk !== 'stone-coated')) {
    return { ok: false, error: 'materialKey must be alu, aluzinc, or stone-coated.' };
  }
  const events = db
    .prepare(
      `SELECT id, row_id, material_key, gauge_mm, branch_id, design_key, payload_json, changed_at_iso, changed_by_user_id, action
       FROM material_pricing_sheet_events
       WHERE material_key = ?
       ORDER BY changed_at_iso DESC
       LIMIT ?`
    )
    .all(mk, limit)
    .map((row) => ({
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

function positiveOrNull(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} body
 * @param {object} actor
 */
export function upsertMaterialPricingSheetRow(db, body, actor) {
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
    const resolved = resolveCoilConversionsForGauge(db, materialKey, gaugeMm);
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
  const listPriceForSync = roundPublishedPrice(minimum + commission);

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
    JSON.stringify({ before, after }),
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

  let priceListSync = null;
  if (syncMinimumToPriceList && listPriceForSync > 0) {
    let syncDesign = syncDesignKeyStored || normKey(body?.syncDesignKey ?? body?.priceListDesignKey ?? '');
    if (materialKey === 'stone-coated') {
      syncDesign = syncDesign || 'stone-coated';
    }
    if (!syncDesign) {
      priceListSync = { ok: false, error: 'syncDesignKey is required to sync list price into the floor price list.' };
    } else {
      const plId = `PL-MPS-${String(id).replace(/^MPS-/i, '').slice(0, 16)}`;
      const mtKey = materialKey === 'stone-coated' ? 'stone-coated' : materialKey;
      const pl = upsertPriceListItem(
        db,
        {
          id: plId,
          gaugeKey: gaugeMm,
          designKey: syncDesign,
          unitPricePerMeterNgn: listPriceForSync,
          branchId,
          notes: `Synced from material pricing (${materialKey}): floor + commission, published rounding.`,
          materialTypeKey: mtKey,
        },
        actor
      );
      priceListSync = pl;
    }
  }

  return { ok: true, id, row: after, priceListSync };
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
  db.prepare(`DELETE FROM material_pricing_sheet_rows WHERE id = ?`).run(id);
  appendAuditLog(db, {
    actor,
    action: 'pricing.material_sheet_delete',
    entityKind: 'material_pricing_sheet_row',
    entityId: id,
    note: `${existing.material_key} · ${existing.gauge_mm} mm · ${existing.branch_id}`,
  });
  return { ok: true };
}
