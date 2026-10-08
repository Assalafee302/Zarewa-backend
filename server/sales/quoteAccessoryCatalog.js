/**
 * Quote accessory lines must come from setup_quote_items (master list) with stock linked by product id.
 * Free-text block is opt-in via ZAREWA_BLOCK_FREE_TEXT_ACCESSORIES=1 until master list is confirmed.
 */

function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** On by default after Phase 1 deploy; set ZAREWA_BLOCK_FREE_TEXT_ACCESSORIES=0 to disable. */
export function freeTextAccessoriesBlocked() {
  if (process.env.ZAREWA_BLOCK_FREE_TEXT_ACCESSORIES === '0') return false;
  if (process.env.ZAREWA_BLOCK_FREE_TEXT_ACCESSORIES === '1') return true;
  return true;
}

/**
 * @returns {{ ok: true, lines: object[] } | { ok: false, error: string, unknownNames?: string[] }}
 */
export function assertQuoteAccessoriesFromMaster(db, accessories) {
  const list = Array.isArray(accessories) ? accessories : [];
  if (!list.length) return { ok: true, lines: [] };
  if (!freeTextAccessoriesBlocked()) {
    return { ok: true, lines: list, enforced: false };
  }

  const setup = db
    .prepare(
      `SELECT item_id, name, unit, floor_unit_price_ngn, inventory_product_id, active
       FROM setup_quote_items WHERE item_type = 'accessory'`
    )
    .all();
  const byId = new Map(setup.map((r) => [String(r.item_id), r]));
  const byNorm = new Map();
  for (const r of setup) {
    const k = normName(r.name);
    if (!byNorm.has(k)) byNorm.set(k, []);
    byNorm.get(k).push(r);
  }

  const unknown = [];
  const ambiguous = [];
  const normalized = [];

  for (const a of list) {
    const itemId = String(a?.setupQuoteItemId || a?.itemId || a?.quoteItemId || a?.id || '').trim();
    const name = String(a?.name ?? a?.itemName ?? a?.label ?? '').trim();
    let row = itemId ? byId.get(itemId) : null;
    if (!row && name) {
      const hits = byNorm.get(normName(name)) || [];
      if (hits.length === 1) row = hits[0];
      else if (hits.length > 1) ambiguous.push(name);
    }
    if (!row || !row.active) {
      unknown.push(name || itemId || '(blank)');
      continue;
    }
    const inv = String(row.inventory_product_id || '').trim();
    if (!inv) {
      unknown.push(`${row.name} (no stock link)`);
      continue;
    }
    normalized.push({
      ...a,
      setupQuoteItemId: row.item_id,
      name: row.name,
      unit: row.unit,
      inventoryProductId: inv,
      floorUnitPriceNgn: Number(row.floor_unit_price_ngn) || 0,
    });
  }

  if (ambiguous.length) {
    return {
      ok: false,
      error: `Ambiguous accessory name(s): ${ambiguous.join(', ')}. Pick from the master list.`,
      ambiguousNames: ambiguous,
    };
  }
  if (unknown.length) {
    return {
      ok: false,
      error: `Unknown or unlinked accessory line(s): ${unknown.join(', ')}. Use the master list only.`,
      unknownNames: unknown,
    };
  }
  return { ok: true, lines: normalized, enforced: true };
}

/**
 * Below-floor check for accessory lines (uses floor on setup item / normalized line).
 * @returns {{ code: string, name: string, unitPriceNgn: number, floorUnitPriceNgn: number }[]}
 */
export function accessoryBelowFloorViolations(lines) {
  const out = [];
  for (const a of lines || []) {
    const floor = Number(a.floorUnitPriceNgn ?? a.floor_unit_price_ngn) || 0;
    if (floor <= 0) continue;
    const price = Number(a.unitPrice ?? a.unit_price ?? a.unitPriceNgn ?? a.price) || 0;
    if (price > 0 && price + 1e-9 < floor) {
      out.push({
        code: 'accessory_below_floor',
        name: String(a.name || ''),
        unitPriceNgn: price,
        floorUnitPriceNgn: floor,
      });
    }
  }
  return out;
}
