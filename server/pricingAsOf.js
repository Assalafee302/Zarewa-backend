/**
 * Period-based price resolution: pick floor/list ₦/m effective on a given date (YYYY-MM-DD).
 * Used for refunds, substitution, historical price-list print, and quotation-period checks.
 */

import { publishedListPriceFromWorkbook } from '../shared/lib/materialWorkbookQuotationPrice.js';

const DEFAULT_EFFECTIVE_FROM = '2020-01-01';

function canReadPriceListItems(db) {
  try {
    db.prepare(`SELECT 1 FROM price_list_items LIMIT 1`).get();
    return true;
  } catch {
    return false;
  }
}

function canReadMaterialPricingSheetRows(db) {
  try {
    db.prepare(`SELECT 1 FROM material_pricing_sheet_rows LIMIT 1`).get();
    return true;
  } catch {
    return false;
  }
}

function normKey(s) {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** @param {string | null | undefined} iso */
export function normalizePricingAsAtIso(iso) {
  const t = String(iso ?? '').trim().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  return new Date().toISOString().slice(0, 10);
}

/** @param {{ date_iso?: string | null; created_at_iso?: string | null }} quoteRow */
export function quotationPricingAsAtIso(quoteRow) {
  const d = String(quoteRow?.date_iso ?? '').trim().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(d)) return d;
  const c = String(quoteRow?.created_at_iso ?? '').trim().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(c)) return c;
  return normalizePricingAsAtIso(null);
}

/** @param {Record<string, unknown>} row */
function priceListRowEffectiveFrom(row) {
  const e = String(row.effective_from_iso ?? row.effectiveFromIso ?? '').trim().slice(0, 10);
  return e || DEFAULT_EFFECTIVE_FROM;
}

/** @param {Record<string, unknown>} row */
function priceListScopeKey(row) {
  const branch = row.branch_id != null && String(row.branch_id).trim() ? String(row.branch_id).trim() : '';
  return [
    normKey(row.gauge_key ?? row.gaugeKey),
    normKey(row.design_key ?? row.designKey),
    branch,
    normKey(row.material_type_key ?? row.materialTypeKey ?? ''),
    normKey(row.colour_key ?? row.colourKey ?? ''),
    normKey(row.profile_key ?? row.profileKey ?? ''),
  ].join('\0');
}

/**
 * Collapse price_list_items to one row per scope — latest effective_from on/before asAt.
 * @param {Record<string, unknown>[]} allRows
 * @param {string} asAtIso
 */
export function selectPriceListRowsAsOf(allRows, asAtIso) {
  const asAt = normalizePricingAsAtIso(asAtIso);
  /** @type {Map<string, Record<string, unknown>>} */
  const bestByScope = new Map();
  for (const r of allRows || []) {
    const eff = priceListRowEffectiveFrom(r);
    if (eff > asAt) continue;
    const key = priceListScopeKey(r);
    const prev = bestByScope.get(key);
    if (!prev || priceListRowEffectiveFrom(prev) < eff) {
      bestByScope.set(key, r);
    }
  }
  return [...bestByScope.values()];
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} [asAtIso]
 * @param {{ branchId?: string | null }} [opts]
 */
export function listPriceListItemsAsOf(db, asAtIso, opts = {}) {
  if (!canReadPriceListItems(db)) return [];
  const asAt = normalizePricingAsAtIso(asAtIso);
  const branchFilter =
    opts.branchId != null && String(opts.branchId).trim() ? String(opts.branchId).trim() : null;
  let rows = db.prepare(`SELECT * FROM price_list_items`).all();
  if (branchFilter) {
    rows = rows.filter(
      (r) =>
        r.branch_id == null ||
        !String(r.branch_id).trim() ||
        String(r.branch_id).trim() === branchFilter
    );
  }
  const collapsed = selectPriceListRowsAsOf(rows, asAt);
  return collapsed
    .map((row) => ({
      id: row.id,
      gaugeKey: row.gauge_key,
      designKey: row.design_key,
      unitPricePerMeterNgn: Math.round(Number(row.unit_price_per_meter_ngn) || 0),
      sortOrder: Number(row.sort_order) || 0,
      notes: row.notes ?? '',
      branchId: row.branch_id ?? null,
      effectiveFromIso: priceListRowEffectiveFrom(row),
      updatedAtIso: row.updated_at_iso ?? null,
      updatedByUserId: row.updated_by_user_id ?? null,
      materialTypeKey: row.material_type_key ?? '',
      colourKey: row.colour_key ?? '',
      profileKey: row.profile_key ?? '',
      pricingAsAtIso: asAt,
    }))
    .sort((a, b) => {
      const g = String(a.gaugeKey).localeCompare(String(b.gaugeKey));
      if (g !== 0) return g;
      return String(a.designKey).localeCompare(String(b.designKey));
    });
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} ctx
 * @param {string | null | undefined} asAtIso
 */
export function resolvePriceListItemFloorNgnAsOf(db, ctx, asAtIso) {
  if (!canReadPriceListItems(db)) return null;
  const asAt = normalizePricingAsAtIso(asAtIso ?? ctx?.asAtIso);
  const g = normKey(ctx.gaugeLabel || ctx.gaugeId);
  const d = normKey(ctx.designLabel || ctx.profileName || ctx.colourName);
  const mt = normKey(ctx.materialTypeName || ctx.materialTypeId);
  const col = normKey(ctx.colourName);
  const prof = normKey(ctx.profileName);
  const bid = ctx.branchId != null ? String(ctx.branchId).trim() || null : null;

  const rows = selectPriceListRowsAsOf(db.prepare(`SELECT * FROM price_list_items`).all(), asAt);
  let best = null;
  let bestScore = -1;
  for (const r of rows) {
    const rg = normKey(r.gauge_key);
    const rd = normKey(r.design_key);
    const rmt = normKey(r.material_type_key || '');
    const rcol = normKey(r.colour_key || '');
    const rprof = normKey(r.profile_key || '');
    if (g && rg && rg !== g) continue;
    if (d && rd && rd !== d) continue;
    if (rmt && mt && !mt.includes(rmt) && !rmt.includes(mt)) continue;
    if (rcol && col && rcol !== col) continue;
    if (rprof && prof && rprof !== prof) continue;
    if (bid && r.branch_id != null && String(r.branch_id).trim() && String(r.branch_id).trim() !== bid) continue;

    let score = 0;
    if (g && rg === g) score += 2;
    if (d && rd === d) score += 2;
    if (rmt) score += 2;
    if (rcol) score += 2;
    if (rprof) score += 2;
    if (score > bestScore) {
      bestScore = score;
      best = r;
    }
  }
  if (!best || bestScore <= 0) return null;
  const n = Math.round(Number(best.unit_price_per_meter_ngn) || 0);
  if (n <= 0) return null;
  return {
    unitPricePerMeterNgn: n,
    source: 'price_list_items',
    id: best.id,
    effectiveFromIso: priceListRowEffectiveFrom(best),
    pricingAsAtIso: asAt,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} gaugeKey
 * @param {string} designKey
 * @param {string | null} branchId
 * @param {string | null | undefined} asAtIso
 */
export function floorPricePerMeterForGaugeDesignAsOf(db, gaugeKey, designKey, branchId, asAtIso) {
  const g = normKey(gaugeKey);
  const d = normKey(designKey);
  if (!g || !d) return null;
  const bid = branchId && String(branchId).trim() ? String(branchId).trim() : null;
  const asAt = normalizePricingAsAtIso(asAtIso);
  const rows = selectPriceListRowsAsOf(db.prepare(`SELECT * FROM price_list_items`).all(), asAt);
  let best = null;
  for (const row of rows) {
    if (normKey(row.gauge_key) !== g || normKey(row.design_key) !== d) continue;
    const rb = row.branch_id != null && String(row.branch_id).trim() ? String(row.branch_id).trim() : null;
    if (bid && rb && rb !== bid) continue;
    if (!best) {
      best = row;
      continue;
    }
    const bestBranch = best.branch_id != null && String(best.branch_id).trim();
    const rowBranch = rb;
    if (bid && rowBranch === bid && bestBranch !== bid) best = row;
  }
  if (!best) return null;
  return Math.round(Number(best.unit_price_per_meter_ngn) || 0) || null;
}

/**
 * Workbook row state (minimum floor) as at a date from change events + current row fallback.
 * @returns {{ minimumPricePerMeterNgn: number; commissionNgnPerM?: number } | null}
 */
export function resolveWorkbookRowStateAsOf(db, materialKey, gaugeMm, branchId, designKey, asAtIso) {
  if (!canReadMaterialPricingSheetRows(db)) return null;
  const mk = normKey(materialKey);
  const g = String(gaugeMm ?? '').trim();
  const bid = String(branchId ?? '').trim();
  const d = normKey(designKey ?? '');
  if (!mk || !g || !bid) return null;

  const asAt = normalizePricingAsAtIso(asAtIso);
  let events = [];
  try {
    events = db
      .prepare(
        `SELECT payload_json, changed_at_iso FROM material_pricing_sheet_events
         WHERE material_key = ? AND gauge_mm = ? AND branch_id = ? AND design_key = ?
         ORDER BY changed_at_iso ASC`
      )
      .all(mk, g, bid, d);
  } catch {
    events = [];
  }

  /** @type {Record<string, unknown> | null} */
  let state = null;
  for (const ev of events) {
    const day = String(ev.changed_at_iso ?? '').slice(0, 10);
    if (!day || day > asAt) break;
    try {
      const p = JSON.parse(String(ev.payload_json || '{}'));
      if (p?.after && typeof p.after === 'object') state = p.after;
    } catch {
      /* ignore */
    }
  }
  if (!state) {
    for (const ev of events) {
      const day = String(ev.changed_at_iso ?? '').slice(0, 10);
      if (day > asAt) {
        try {
          const p = JSON.parse(String(ev.payload_json || '{}'));
          if (p?.before && typeof p.before === 'object') state = p.before;
        } catch {
          /* ignore */
        }
        break;
      }
    }
  }
  if (!state) {
    try {
      const row = db
        .prepare(
          `SELECT minimum_price_per_m_ngn, commission_ngn_per_m, updated_at_iso FROM material_pricing_sheet_rows
           WHERE material_key = ? AND gauge_mm = ? AND branch_id = ? AND design_key = ?`
        )
        .get(mk, g, bid, d);
      if (row) {
        const updatedDay = String(row.updated_at_iso ?? '').slice(0, 10);
        if (!updatedDay || updatedDay <= asAt) {
          state = {
            minimumPricePerMeterNgn: Math.round(Number(row.minimum_price_per_m_ngn) || 0),
            commissionNgnPerM: Math.max(0, Number(row.commission_ngn_per_m) || 0),
          };
        }
      }
    } catch {
      /* ignore */
    }
  }
  if (!state) return null;
  const minimum = Math.max(0, Math.round(Number(state.minimumPricePerMeterNgn) || 0));
  if (minimum <= 0) return null;
  return {
    minimumPricePerMeterNgn: minimum,
    commissionNgnPerM: Math.max(0, Number(state.commissionNgnPerM) || 0),
    pricingAsAtIso: asAt,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} materialKey
 * @param {string} gaugeMmKey
 * @param {string} designKeyNorm
 * @param {string} sheetBranchId
 * @param {string | null | undefined} asAtIso
 */
export function workbookFloorPerMeterAsOf(db, materialKey, gaugeMmKey, designKeyNorm, sheetBranchId, asAtIso) {
  const hit = resolveWorkbookRowStateAsOf(
    db,
    materialKey,
    gaugeMmKey,
    sheetBranchId,
    designKeyNorm,
    asAtIso
  );
  return hit?.minimumPricePerMeterNgn > 0 ? hit.minimumPricePerMeterNgn : null;
}

/**
 * Minimum floor across all designs for gauge+branch as at date.
 */
export function workbookFloorMinPerMeterAsOf(db, materialKey, gaugeMmKey, sheetBranchId, asAtIso) {
  if (!canReadMaterialPricingSheetRows(db)) return null;
  const mk = normKey(materialKey);
  const g = String(gaugeMmKey ?? '').trim();
  const bid = String(sheetBranchId ?? '').trim();
  if (!mk || !g || !bid) return null;

  let designKeys = [];
  try {
    designKeys = db
      .prepare(
        `SELECT DISTINCT design_key FROM material_pricing_sheet_rows
         WHERE material_key = ? AND gauge_mm = ? AND branch_id = ?`
      )
      .all(mk, g, bid)
      .map((r) => String(r.design_key ?? '').trim());
  } catch {
    designKeys = [];
  }

  let min = 0;
  for (const dk of designKeys) {
    const f = workbookFloorPerMeterAsOf(db, mk, g, dk, bid, asAtIso);
    if (f != null && f > 0 && (min === 0 || f < min)) min = f;
  }
  const blank = workbookFloorPerMeterAsOf(db, mk, g, '', bid, asAtIso);
  if (blank != null && blank > 0 && (min === 0 || blank < min)) min = blank;
  return min > 0 ? min : null;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string | null | undefined} branchId
 * @param {string | null | undefined} asAtIso
 */
export function listMaterialPricingRowsAsOf(db, branchId, asAtIso) {
  if (!canReadMaterialPricingSheetRows(db)) return [];
  const bid = String(branchId ?? '').trim();
  if (!bid) return [];
  const asAt = normalizePricingAsAtIso(asAtIso);

  /** @type {Set<string>} */
  const keySet = new Set();
  const addKey = (mk, g, b, dk) => {
    keySet.add(`${normKey(mk)}\0${String(g).trim()}\0${String(b).trim()}\0${normKey(dk)}`);
  };

  try {
    const rows = db
      .prepare(
        `SELECT material_key, gauge_mm, branch_id, design_key FROM material_pricing_sheet_rows WHERE branch_id = ?`
      )
      .all(bid);
    for (const r of rows) addKey(r.material_key, r.gauge_mm, r.branch_id, r.design_key);
  } catch {
    /* ignore */
  }

  try {
    const evs = db
      .prepare(
        `SELECT material_key, gauge_mm, branch_id, design_key, changed_at_iso FROM material_pricing_sheet_events WHERE branch_id = ?`
      )
      .all(bid);
    for (const e of evs) {
      if (String(e.changed_at_iso ?? '').slice(0, 10) <= asAt) {
        addKey(e.material_key, e.gauge_mm, e.branch_id, e.design_key);
      }
    }
  } catch {
    /* ignore */
  }

  const out = [];
  for (const key of keySet) {
    const [mk, g, b, dk] = key.split('\0');
    const state = resolveWorkbookRowStateAsOf(db, mk, g, b, dk, asAt);
    if (!state || state.minimumPricePerMeterNgn <= 0) continue;
    const commission = Math.max(0, Number(state.commissionNgnPerM) || 0);
    const floor = state.minimumPricePerMeterNgn;
    out.push({
      materialKey: mk,
      gaugeMm: g,
      branchId: b,
      designKey: dk,
      minimumPricePerMeterNgn: floor,
      commissionNgnPerM: commission,
      publishedListPriceNgn: publishedListPriceFromWorkbook(floor, commission),
      pricingAsAtIso: asAt,
    });
  }
  return out.sort((a, b) => {
    const m = String(a.materialKey).localeCompare(String(b.materialKey));
    if (m !== 0) return m;
    const g = String(a.gaugeMm).localeCompare(String(b.gaugeMm));
    if (g !== 0) return g;
    return String(a.designKey).localeCompare(String(b.designKey));
  });
}

/**
 * setup_price_lists row effective on asAt (specificity scoring).
 * @param {import('better-sqlite3').Database} db
 * @param {object} ctx
 * @param {string | null | undefined} asAtIso
 */
export function resolveSetupPriceListUnitNgnAsOf(db, ctx, asAtIso) {
  const asAt = normalizePricingAsAtIso(asAtIso ?? ctx?.asAtIso);
  const qid = String(ctx.quoteItemId || '').trim();
  const gid = String(ctx.gaugeId || '').trim();
  const cid = String(ctx.colourId || '').trim();
  const mtid = String(ctx.materialTypeId || '').trim();
  const pid = String(ctx.profileId || '').trim();

  let rows = [];
  try {
    rows = db
      .prepare(`SELECT * FROM setup_price_lists WHERE active = 1 ORDER BY sort_order ASC, price_id ASC`)
      .all();
  } catch {
    return null;
  }

  /** @type {Map<string, Record<string, unknown>>} */
  const byPriceId = new Map();
  for (const r of rows) {
    const eff = String(r.effective_from_iso ?? DEFAULT_EFFECTIVE_FROM).trim().slice(0, 10);
    if (eff > asAt) continue;
    const pidKey = String(r.price_id || '').trim();
    const prev = byPriceId.get(pidKey);
    if (!prev || String(prev.effective_from_iso ?? '').slice(0, 10) < eff) {
      byPriceId.set(pidKey, r);
    }
  }
  const pool = [...byPriceId.values()];

  let best = null;
  let bestScore = -1;
  for (const r of pool) {
    let score = 0;
    if (qid && String(r.quote_item_id || '').trim() === qid) score += 8;
    if (gid && String(r.gauge_id || '').trim() === gid) score += 4;
    if (cid && String(r.colour_id || '').trim() === cid) score += 4;
    if (mtid && String(r.material_type_id || '').trim() === mtid) score += 4;
    if (pid && String(r.profile_id || '').trim() === pid) score += 4;
    if (score > bestScore && Number(r.unit_price_ngn) > 0) {
      bestScore = score;
      best = r;
    }
  }
  if (!best || bestScore <= 0) return null;
  return {
    unitPriceNgn: Math.round(Number(best.unit_price_ngn) || 0),
    source: 'setup_price_lists',
    priceId: best.price_id,
    effectiveFromIso: String(best.effective_from_iso ?? '').slice(0, 10) || DEFAULT_EFFECTIVE_FROM,
    pricingAsAtIso: asAt,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} ctx
 * @param {string | null | undefined} [asAtIso]
 */
export function resolveQuotedUnitPriceAsOf(db, ctx, asAtIso) {
  const asAt = normalizePricingAsAtIso(asAtIso ?? ctx?.asAtIso);
  const primary = resolveSetupPriceListUnitNgnAsOf(db, ctx, asAt);
  if (primary) return { ...primary, unit: 'setup' };
  const floor = resolvePriceListItemFloorNgnAsOf(db, ctx, asAt);
  if (floor) {
    return {
      unitPriceNgn: floor.unitPricePerMeterNgn,
      source: floor.source,
      priceId: floor.id,
      unit: 'floor',
      pricingAsAtIso: asAt,
    };
  }
  return null;
}
