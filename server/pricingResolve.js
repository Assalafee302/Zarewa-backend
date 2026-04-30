/**
 * Unified selling-price resolution: setup_price_lists (primary) with specificity scoring,
 * then optional floor from price_list_items when extended keys match.
 */

function normKey(s) {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{
 *   quoteItemId?: string,
 *   gaugeId?: string,
 *   colourId?: string,
 *   materialTypeId?: string,
 *   profileId?: string,
 *   branchId?: string | null,
 * }} ctx
 * @returns {{ unitPriceNgn: number, source: string, priceId?: string } | null}
 */
export function resolveSetupPriceListUnitNgn(db, ctx) {
  const qid = String(ctx.quoteItemId || '').trim();
  const gid = String(ctx.gaugeId || '').trim();
  const cid = String(ctx.colourId || '').trim();
  const mtid = String(ctx.materialTypeId || '').trim();
  const pid = String(ctx.profileId || '').trim();

  const rows = db
    .prepare(
      `SELECT * FROM setup_price_lists WHERE active = 1 ORDER BY sort_order ASC, price_id ASC`
    )
    .all();
  let best = null;
  let bestScore = -1;
  for (const r of rows) {
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
  };
}

/**
 * Extended floor / list row from price_list_items (gauge_key, design_key, optional material/colour/profile keys).
 * @param {import('better-sqlite3').Database} db
 */
export function resolvePriceListItemFloorNgn(db, ctx) {
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='price_list_items'`).get()) {
    return null;
  }
  const g = normKey(ctx.gaugeLabel || ctx.gaugeId);
  const d = normKey(ctx.designLabel || ctx.profileName || ctx.colourName);
  const mt = normKey(ctx.materialTypeName || ctx.materialTypeId);
  const col = normKey(ctx.colourName);
  const prof = normKey(ctx.profileName);
  const bid = ctx.branchId != null ? String(ctx.branchId).trim() || null : null;

  const rows = db.prepare(`SELECT * FROM price_list_items`).all();
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
  return { unitPricePerMeterNgn: n, source: 'price_list_items', id: best.id };
}

/**
 * Prefer setup list; fall back to price_list_items floor.
 */
export function resolveQuotedUnitPrice(db, ctx) {
  const primary = resolveSetupPriceListUnitNgn(db, ctx);
  if (primary) return { ...primary, unit: 'setup' };
  const floor = resolvePriceListItemFloorNgn(db, ctx);
  if (floor) return { unitPriceNgn: floor.unitPricePerMeterNgn, source: floor.source, priceId: floor.id, unit: 'floor' };
  return null;
}
