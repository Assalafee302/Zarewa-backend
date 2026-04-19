import crypto from 'node:crypto';
import { appendAuditLog } from './controlOps.js';
import { upsertPriceListItem } from './pricingOps.js';

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
  return {
    id: row.id,
    materialKey: row.material_key,
    gaugeMm: row.gauge_mm,
    branchId: row.branch_id,
    designKey: row.design_key ?? '',
    conversionStandardKgPerM: Number.isFinite(std) && std > 0 ? std : null,
    conversionReferenceKgPerM: Number.isFinite(ref) && ref > 0 ? ref : null,
    conversionHistoryKgPerM: Number.isFinite(hist) && hist > 0 ? hist : null,
    conversionAvgKgPerM: avg,
    conversionUsedKgPerM: Number.isFinite(used) && used > 0 ? used : null,
    costPerKgNgn: costKg,
    overheadNgnPerM: oh,
    profitNgnPerM: pr,
    suggestedPricePerMeterNgn: suggested,
    minimumPricePerMeterNgn: Math.max(0, Math.round(Number(row.minimum_price_per_m_ngn) || 0)),
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
  if (!mk || (mk !== 'alu' && mk !== 'aluzinc')) {
    return { ok: false, error: 'materialKey must be alu or aluzinc.' };
  }
  if (!bid) return { ok: false, error: 'branchId is required.' };
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='material_pricing_sheet_rows'`).get()) {
    return {
      ok: true,
      materialKey: mk,
      branchId: bid,
      gauges: [...MATERIAL_PRICING_STANDARD_GAUGES_MM],
      theoreticalStandardByGauge: {},
      catalogHintByGauge: {},
      rows: [],
    };
  }
  const pid = productIdForMaterialKey(mk);
  const theoreticalStandardByGauge = {};
  const catalogHintByGauge = {};
  for (const g of MATERIAL_PRICING_STANDARD_GAUGES_MM) {
    const mm = parseFloat(g, 10);
    const t = theoreticalStandardKgPerM(mk, mm);
    if (t != null) theoreticalStandardByGauge[g] = t;
    const c = catalogStandardKgPerM(db, pid, g);
    if (c != null) catalogHintByGauge[g] = c;
  }
  const dbRows = db
    .prepare(
      `SELECT * FROM material_pricing_sheet_rows
       WHERE material_key = ? AND branch_id = ?
       ORDER BY gauge_mm ASC, design_key ASC`
    )
    .all(mk, bid)
    .map((r) => mapRow(r));
  return {
    ok: true,
    materialKey: mk,
    branchId: bid,
    gauges: [...MATERIAL_PRICING_STANDARD_GAUGES_MM],
    theoreticalStandardByGauge,
    catalogHintByGauge,
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
  if (!mk || (mk !== 'alu' && mk !== 'aluzinc')) {
    return { ok: false, error: 'materialKey must be alu or aluzinc.' };
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
  if (!materialKey || (materialKey !== 'alu' && materialKey !== 'aluzinc')) {
    return { ok: false, error: 'materialKey must be alu or aluzinc.' };
  }
  if (!gaugeMm || gaugeMm.length > 32) return { ok: false, error: 'gaugeMm is required (max 32 chars).' };
  if (!branchId || branchId.length > 64) return { ok: false, error: 'branchId is required.' };
  if (designKey.length > 120) return { ok: false, error: 'designKey is too long.' };

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

  const std = positiveOrNull(body?.conversionStandardKgPerM);
  const ref = positiveOrNull(body?.conversionReferenceKgPerM);
  const hist = positiveOrNull(body?.conversionHistoryKgPerM);
  const used = positiveOrNull(body?.conversionUsedKgPerM);
  const costPerKg = Math.max(0, Number(body?.costPerKgNgn) || 0);
  const overhead = Math.max(0, Number(body?.overheadNgnPerM) || 0);
  const profit = Math.max(0, Number(body?.profitNgnPerM) || 0);
  const minimum = Math.max(0, Math.round(Number(body?.minimumPricePerMeterNgn) || 0));
  const notes = body?.notes != null ? String(body.notes).trim().slice(0, 2000) : '';

  const now = new Date().toISOString();
  const before = existing ? mapRow(existing) : null;

  if (existing) {
    db.prepare(
      `UPDATE material_pricing_sheet_rows SET
        conversion_standard_kg_per_m = ?, conversion_reference_kg_per_m = ?, conversion_history_kg_per_m = ?,
        conversion_used_kg_per_m = ?, cost_per_kg_ngn = ?, overhead_ngn_per_m = ?, profit_ngn_per_m = ?,
        minimum_price_per_m_ngn = ?, notes = ?, updated_at_iso = ?, updated_by_user_id = ?
       WHERE id = ?`
    ).run(std, ref, hist, used, costPerKg, overhead, profit, minimum, notes || null, now, actor?.id ?? null, id);
  } else {
    db.prepare(
      `INSERT INTO material_pricing_sheet_rows (
        id, material_key, gauge_mm, branch_id, design_key,
        conversion_standard_kg_per_m, conversion_reference_kg_per_m, conversion_history_kg_per_m,
        conversion_used_kg_per_m, cost_per_kg_ngn, overhead_ngn_per_m, profit_ngn_per_m,
        minimum_price_per_m_ngn, notes, updated_at_iso, updated_by_user_id
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
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
      notes || null,
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
  if (body?.syncMinimumToPriceList && minimum > 0) {
    const syncDesign = normKey(body?.syncDesignKey ?? body?.priceListDesignKey ?? '');
    if (!syncDesign) {
      priceListSync = { ok: false, error: 'syncDesignKey is required to sync minimum into the floor price list.' };
    } else {
      const plId = `PL-MPS-${String(id).replace(/^MPS-/i, '').slice(0, 16)}`;
      const pl = upsertPriceListItem(
        db,
        {
          id: plId,
          gaugeKey: gaugeMm,
          designKey: syncDesign,
          unitPricePerMeterNgn: minimum,
          branchId,
          notes: `Synced from material pricing (${materialKey}).`,
          materialTypeKey: materialKey,
        },
        actor
      );
      priceListSync = pl;
    }
  }

  return { ok: true, id, row: after, priceListSync };
}
