/**
 * Quote accessory lines must come from setup_quote_items (master list) with stock linked by product id.
 * Free-text block is on by default; set ZAREWA_BLOCK_FREE_TEXT_ACCESSORIES=0 to disable.
 *
 * UI line ids look like `L1791550302568-zhl8a8e` — they are not catalog ids. Match by
 * setupQuoteItemId / SQI-* / inventory product / accessory name only.
 */

function normName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Client-generated quotation line ids (not setup_quote_items.item_id). */
export function isClientQuoteLineId(id) {
  return /^L\d+/i.test(String(id || '').trim());
}

function isSetupActive(row) {
  if (!row) return false;
  const v = row.active;
  return !(v === false || v === 0 || v === '0');
}

function accessoryLineName(a) {
  const nested = a?.item && typeof a.item === 'object' ? a.item : null;
  return String(
    a?.name ??
      a?.itemName ??
      a?.label ??
      a?.productName ??
      a?.description ??
      a?.title ??
      nested?.name ??
      nested?.itemName ??
      nested?.label ??
      ''
  ).trim();
}

/**
 * Prefer explicit catalog fields; never treat client `L…` line ids as master-list ids.
 */
function accessoryCatalogId(a) {
  const nested = a?.item && typeof a.item === 'object' ? a.item : null;
  const candidates = [
    a?.setupQuoteItemId,
    a?.quoteItemId,
    a?.itemId,
    nested?.setupQuoteItemId,
    nested?.quoteItemId,
    nested?.itemId,
    nested?.id,
    a?.id,
  ];
  for (const c of candidates) {
    const id = String(c ?? '').trim();
    if (!id || isClientQuoteLineId(id)) continue;
    return id;
  }
  return '';
}

function accessoryInventoryProductId(a) {
  const nested = a?.item && typeof a.item === 'object' ? a.item : null;
  return String(
    a?.inventoryProductId ?? a?.inventory_product_id ?? nested?.inventoryProductId ?? nested?.inventory_product_id ?? ''
  ).trim();
}

function accessoryQty(a) {
  return Number(String(a?.qty ?? a?.quantity ?? a?.orderedQty ?? '').replace(/,/g, '')) || 0;
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
       FROM setup_quote_items WHERE lower(trim(item_type)) = 'accessory'`
    )
    .all();
  const byId = new Map(setup.map((r) => [String(r.item_id), r]));
  const byInv = new Map();
  const byNorm = new Map();
  for (const r of setup) {
    const inv = String(r.inventory_product_id || '').trim();
    if (inv && !byInv.has(inv)) byInv.set(inv, r);
    const k = normName(r.name);
    if (!byNorm.has(k)) byNorm.set(k, []);
    byNorm.get(k).push(r);
  }

  const unknown = [];
  const ambiguous = [];
  const normalized = [];

  for (const a of list) {
    const catalogId = accessoryCatalogId(a);
    const name = accessoryLineName(a);
    const invHint = accessoryInventoryProductId(a);
    const qty = accessoryQty(a);

    // Draft row: UI often allocates `L…` before the user picks a master item.
    if (!catalogId && !name && !invHint && qty <= 0) {
      continue;
    }

    let row = catalogId ? byId.get(catalogId) : null;
    if (!row && invHint) {
      row = byInv.get(invHint) || null;
    }
    if (!row && name) {
      const hits = byNorm.get(normName(name)) || [];
      if (hits.length === 1) row = hits[0];
      else if (hits.length > 1) ambiguous.push(name);
    }
    if (!row || !isSetupActive(row)) {
      const label = name || catalogId || invHint || '(blank accessory line)';
      unknown.push(label);
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
