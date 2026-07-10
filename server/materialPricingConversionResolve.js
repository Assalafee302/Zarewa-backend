/**
 * Coil conversion resolution for material pricing workbook.
 * Std = catalog ?? theory (aligned with production). Ref/Hist include sample confidence.
 *
 * v1 non-goals (tracked for later): VAT/FX layers, scrap/yield %, maker-checker on publish,
 * branch matrix report UI, mobile-first workbook.
 */
import { roundConv2 } from '../shared/lib/conversionKgPerM.js';
import {
  STANDARD_COIL_GAUGES_MM,
  productIdForMaterialKey,
  theoreticalStandardKgPerM,
  standardGaugeKeyForMm,
} from '../shared/lib/coilDensityStandard.js';

export {
  STANDARD_COIL_GAUGES_MM,
  productIdForMaterialKey,
  theoreticalStandardKgPerM,
  standardGaugeKeyForMm,
} from '../shared/lib/coilDensityStandard.js';

/** @type {readonly string[]} */
export const MATERIAL_PRICING_STANDARD_GAUGES_MM = STANDARD_COIL_GAUGES_MM;

/** @type {Map<string, boolean>} */
const pragmaColumnCache = new Map();
/** @type {Map<string, boolean>} */
const tableExistsCache = new Map();

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} table
 * @param {string} column
 */
function pragmaHasColumn(db, table, column) {
  const key = `${table}\0${column}`;
  if (pragmaColumnCache.has(key)) return pragmaColumnCache.get(key);
  let ok = false;
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all();
    ok = rows.some((r) => String(r.name) === column);
  } catch {
    ok = false;
  }
  pragmaColumnCache.set(key, ok);
  return ok;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} name
 */
function tableExists(db, name) {
  const key = String(name || '');
  if (tableExistsCache.has(key)) return tableExistsCache.get(key);
  let ok = false;
  try {
    ok = Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(key));
  } catch {
    ok = false;
  }
  tableExistsCache.set(key, ok);
  return ok;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} productId
 * @returns {Record<string, number>}
 */
export function catalogStandardKgPerMByGauge(db, productId) {
  /** @type {Record<string, number>} */
  const out = {};
  const pid = String(productId || '').trim();
  if (!pid || !tableExists(db, 'procurement_catalog')) return out;
  const rows = db
    .prepare(
      `SELECT gauge, conversion_kg_per_m FROM procurement_catalog
       WHERE product_id = ? AND conversion_kg_per_m > 0`
    )
    .all(pid);
  /** @type {Record<string, { sum: number; n: number }>} */
  const buckets = {};
  for (const r of rows) {
    const g = String(r.gauge ?? '').trim();
    if (!g) continue;
    const v = Number(r.conversion_kg_per_m);
    if (!Number.isFinite(v) || v <= 0) continue;
    if (!buckets[g]) buckets[g] = { sum: 0, n: 0 };
    buckets[g].sum += v;
    buckets[g].n += 1;
  }
  for (const [g, b] of Object.entries(buckets)) {
    if (b.n > 0) {
      const avg = b.sum / b.n;
      if (avg > 0) out[g] = avg;
    }
  }
  return out;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} productId
 * @param {string} gaugeMm
 * @returns {number | null}
 */
export function catalogStandardKgPerM(db, productId, gaugeMm) {
  if (!productId || !gaugeMm) return null;
  const gKey = String(gaugeMm).trim();
  const byGauge = catalogStandardKgPerMByGauge(db, productId);
  const v = byGauge[gKey];
  return v != null && v > 0 ? v : null;
}

export function isoDateDaysAgo(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - Math.max(1, Math.round(Number(days) || 30)));
  return d.toISOString().slice(0, 10);
}

function parseGaugeMmFromLabel(value) {
  const match = String(value ?? '')
    .replace(/,/g, '.')
    .match(/(\d+(?:\.\d+)?)/);
  if (!match) return null;
  const next = Number(match[1]);
  return Number.isFinite(next) && next > 0 ? next : null;
}

function meanOf(vals) {
  if (!vals?.length) return null;
  const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
  return Number.isFinite(avg) && avg > 0 ? avg : null;
}

function medianOf(vals) {
  if (!vals?.length) return null;
  const sorted = [...vals].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const v = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
  return Number.isFinite(v) && v > 0 ? v : null;
}

function summarizeConversionSamples(vals, lastAtIso = null) {
  const clean = (vals || []).filter((v) => Number.isFinite(v) && v > 0);
  const n = clean.length;
  if (!n) return { avg: null, n: 0, lastAtIso: null };
  const avg = n >= 5 ? medianOf(clean) : meanOf(clean);
  return { avg, n, lastAtIso: lastAtIso || null };
}

/**
 * @param {Record<string, { avg: number | null; n: number; lastAtIso: string | null }>} meta
 * @returns {Record<string, number>}
 */
export function avgMapFromMeta(meta) {
  /** @type {Record<string, number>} */
  const out = {};
  for (const [g, m] of Object.entries(meta || {})) {
    if (m?.avg != null && Number.isFinite(m.avg) && m.avg > 0) out[g] = m.avg;
  }
  return out;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} productId
 * @param {string | null} sinceIso
 * @param {string | null} [branchId]
 */
export function purchaseConversionMetaByGauge(db, productId, sinceIso = null, branchId = null) {
  /** @type {Record<string, { avg: number | null; n: number; lastAtIso: string | null }>} */
  const out = {};
  const pid = String(productId || '').trim();
  if (!pid) return out;
  if (!tableExists(db, 'coil_lots')) return out;
  const since = sinceIso && String(sinceIso).trim().length >= 10 ? String(sinceIso).trim().slice(0, 10) : null;
  const bid = branchId && String(branchId).trim() ? String(branchId).trim() : null;
  const hasBranch = Boolean(bid && pragmaHasColumn(db, 'coil_lots', 'branch_id'));
  let sql = `SELECT gauge_label, supplier_conversion_kg_per_m, received_at_iso FROM coil_lots
           WHERE product_id = ?
             AND supplier_conversion_kg_per_m IS NOT NULL
             AND supplier_conversion_kg_per_m > 0`;
  /** @type {unknown[]} */
  const args = [pid];
  if (since) {
    sql += ` AND received_at_iso IS NOT NULL AND SUBSTR(received_at_iso, 1, 10) >= ?`;
    args.push(since);
  }
  if (hasBranch) {
    sql += ` AND branch_id = ?`;
    args.push(bid);
  }
  const rows = db.prepare(sql).all(...args);
  /** @type {Record<string, { vals: number[]; lastAt: string | null }>} */
  const buckets = {};
  for (const r of rows) {
    const mm = parseGaugeMmFromLabel(r.gauge_label);
    const key = standardGaugeKeyForMm(mm);
    if (!key) continue;
    const v = Number(r.supplier_conversion_kg_per_m);
    if (!Number.isFinite(v) || v <= 0) continue;
    if (!buckets[key]) buckets[key] = { vals: [], lastAt: null };
    buckets[key].vals.push(v);
    const at = r.received_at_iso ? String(r.received_at_iso).slice(0, 10) : null;
    if (at && (!buckets[key].lastAt || at > buckets[key].lastAt)) buckets[key].lastAt = at;
  }
  for (const g of Object.keys(buckets)) {
    out[g] = summarizeConversionSamples(buckets[g].vals, buckets[g].lastAt);
  }
  return out;
}

export function purchaseAvgConversionKgPerMByGauge(db, productId, sinceIso = null, branchId = null) {
  return avgMapFromMeta(purchaseConversionMetaByGauge(db, productId, sinceIso, branchId));
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} productId
 * @param {string | null} sinceIso
 * @param {string | null} [branchId]
 */
export function gaugeHistoryConversionMetaByGauge(db, productId, sinceIso = null, branchId = null) {
  /** @type {Record<string, { avg: number | null; n: number; lastAtIso: string | null }>} */
  const out = {};
  const pid = String(productId || '').trim();
  if (!pid) return out;
  if (!tableExists(db, 'production_conversion_checks') || !tableExists(db, 'coil_lots')) {
    return out;
  }
  const since = sinceIso && String(sinceIso).trim().length >= 10 ? String(sinceIso).trim().slice(0, 10) : null;
  const bid = branchId && String(branchId).trim() ? String(branchId).trim() : null;
  const hasBranch = Boolean(bid && pragmaHasColumn(db, 'coil_lots', 'branch_id'));
  let sql = `SELECT c.gauge_label, c.actual_conversion_kg_per_m, c.checked_at_iso
           FROM production_conversion_checks c
           INNER JOIN coil_lots cl ON cl.coil_no = c.coil_no
           WHERE cl.product_id = ?
             AND c.actual_conversion_kg_per_m IS NOT NULL
             AND c.actual_conversion_kg_per_m > 0`;
  /** @type {unknown[]} */
  const args = [pid];
  if (since) {
    sql += ` AND c.checked_at_iso IS NOT NULL AND SUBSTR(c.checked_at_iso, 1, 10) >= ?`;
    args.push(since);
  }
  if (hasBranch) {
    sql += ` AND cl.branch_id = ?`;
    args.push(bid);
  }
  const rows = db.prepare(sql).all(...args);
  /** @type {Record<string, { vals: number[]; lastAt: string | null }>} */
  const buckets = {};
  for (const r of rows) {
    const mm = parseGaugeMmFromLabel(r.gauge_label);
    const key = standardGaugeKeyForMm(mm);
    if (!key) continue;
    const v = Number(r.actual_conversion_kg_per_m);
    if (!Number.isFinite(v) || v <= 0) continue;
    if (!buckets[key]) buckets[key] = { vals: [], lastAt: null };
    buckets[key].vals.push(v);
    const at = r.checked_at_iso ? String(r.checked_at_iso).slice(0, 10) : null;
    if (at && (!buckets[key].lastAt || at > buckets[key].lastAt)) buckets[key].lastAt = at;
  }
  for (const g of Object.keys(buckets)) {
    out[g] = summarizeConversionSamples(buckets[g].vals, buckets[g].lastAt);
  }
  return out;
}

export function gaugeHistoryAvgConversionKgPerMByGauge(db, productId, sinceIso = null, branchId = null) {
  return avgMapFromMeta(gaugeHistoryConversionMetaByGauge(db, productId, sinceIso, branchId));
}

export function averageOfThreeConversions(a, b, c) {
  const vals = [a, b, c].filter((x) => x != null && Number.isFinite(Number(x)) && Number(x) > 0).map(Number);
  if (!vals.length) return null;
  return vals.reduce((s, x) => s + x, 0) / vals.length;
}

export function usedConfidenceFromMeta(refMeta, histMeta, std) {
  const rn = Number(refMeta?.n) || 0;
  const hn = Number(histMeta?.n) || 0;
  if (rn >= 5 && hn >= 5) return 'high';
  if (rn >= 3 || hn >= 3) return 'medium';
  if (rn > 0 || hn > 0 || (std != null && Number(std) > 0)) return 'low';
  return 'none';
}

function normKey(s) {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

const EMPTY_META = Object.freeze({ avg: null, n: 0, lastAtIso: null });

function emptyResolveResult() {
  return {
    std: null,
    ref: null,
    hist: null,
    usedSuggested: null,
    stdSource: null,
    refMeta: { avg: null, n: 0, lastAtIso: null },
    histMeta: { avg: null, n: 0, lastAtIso: null },
    usedConfidence: /** @type {'none'} */ ('none'),
  };
}

/**
 * Build one gauge resolve result from preloaded meta/catalog maps.
 * @param {string} materialKey
 * @param {string} gaugeMm
 * @param {{
 *   purchaseMeta?: Record<string, { avg: number | null; n: number; lastAtIso: string | null }>;
 *   histMeta?: Record<string, { avg: number | null; n: number; lastAtIso: string | null }>;
 *   catalogByGauge?: Record<string, number>;
 * }} maps
 */
function resolveOneFromMaps(materialKey, gaugeMm, maps) {
  const mk = normKey(materialKey);
  if (mk === 'stone-coated') return emptyResolveResult();
  const gKey = String(gaugeMm).trim();
  const mm = parseFloat(gKey);
  const th = theoreticalStandardKgPerM(mk, mm);
  const catRaw = maps.catalogByGauge?.[gKey];
  const cat = catRaw != null && Number.isFinite(catRaw) && catRaw > 0 ? catRaw : null;
  const stdRaw = cat ?? th ?? null;
  const stdSource = cat != null ? 'catalog' : th != null ? 'theory' : null;
  const refMeta = maps.purchaseMeta?.[gKey] || { ...EMPTY_META };
  const histMeta = maps.histMeta?.[gKey] || { ...EMPTY_META };
  const std = roundConv2(stdRaw);
  const ref = roundConv2(refMeta.avg);
  const hist = roundConv2(histMeta.avg);
  const usedSuggested = roundConv2(averageOfThreeConversions(std, ref, hist));
  const usedConfidence = usedConfidenceFromMeta(refMeta, histMeta, std);
  return { std, ref, hist, usedSuggested, stdSource, refMeta, histMeta, usedConfidence };
}

/**
 * Resolve conversions for all standard gauges of a coil material in one pass.
 * @param {import('better-sqlite3').Database} db
 * @param {string} materialKey
 * @param {{
 *   branchId?: string | null;
 *   gauges?: string[];
 *   purchaseMeta?: Record<string, { avg: number | null; n: number; lastAtIso: string | null }>;
 *   histMeta?: Record<string, { avg: number | null; n: number; lastAtIso: string | null }>;
 *   catalogByGauge?: Record<string, number>;
 * }} [opts]
 * @returns {Record<string, ReturnType<typeof emptyResolveResult>>}
 */
export function resolveCoilConversionsForAllGauges(db, materialKey, opts = {}) {
  const mk = normKey(materialKey);
  const gauges = Array.isArray(opts.gauges) && opts.gauges.length
    ? opts.gauges.map((g) => String(g).trim()).filter(Boolean)
    : [...MATERIAL_PRICING_STANDARD_GAUGES_MM];
  /** @type {Record<string, ReturnType<typeof emptyResolveResult>>} */
  const out = {};
  if (mk === 'stone-coated') {
    for (const g of gauges) out[g] = emptyResolveResult();
    return out;
  }
  const pid = productIdForMaterialKey(mk);
  if (!pid) {
    for (const g of gauges) out[g] = emptyResolveResult();
    return out;
  }
  const bid = opts?.branchId != null ? String(opts.branchId).trim() || null : null;
  const since = isoDateDaysAgo(30);
  const purchaseMeta =
    opts.purchaseMeta ?? purchaseConversionMetaByGauge(db, pid, since, bid);
  const histMeta = opts.histMeta ?? gaugeHistoryConversionMetaByGauge(db, pid, since, bid);
  const catalogByGauge = opts.catalogByGauge ?? catalogStandardKgPerMByGauge(db, pid);
  const maps = { purchaseMeta, histMeta, catalogByGauge };
  for (const g of gauges) {
    out[g] = resolveOneFromMaps(mk, g, maps);
  }
  return out;
}

/**
 * Std = catalog ?? theory (aligned with production register).
 * @param {import('better-sqlite3').Database} db
 * @param {string} materialKey
 * @param {string | number} gaugeMm
 * @param {{
 *   branchId?: string | null;
 *   purchaseMeta?: Record<string, { avg: number | null; n: number; lastAtIso: string | null }>;
 *   histMeta?: Record<string, { avg: number | null; n: number; lastAtIso: string | null }>;
 *   catalogByGauge?: Record<string, number>;
 *   resolvedByGauge?: Record<string, ReturnType<typeof emptyResolveResult>>;
 * }} [opts]
 */
export function resolveCoilConversionsForGauge(db, materialKey, gaugeMm, opts = {}) {
  const gKey = String(gaugeMm).trim();
  if (opts.resolvedByGauge && opts.resolvedByGauge[gKey]) {
    return opts.resolvedByGauge[gKey];
  }
  if (opts.purchaseMeta || opts.histMeta || opts.catalogByGauge) {
    return resolveOneFromMaps(normKey(materialKey), gKey, {
      purchaseMeta: opts.purchaseMeta,
      histMeta: opts.histMeta,
      catalogByGauge: opts.catalogByGauge,
    });
  }
  const all = resolveCoilConversionsForAllGauges(db, materialKey, {
    branchId: opts.branchId,
    gauges: [gKey],
  });
  return all[gKey] || emptyResolveResult();
}
