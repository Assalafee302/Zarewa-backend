/**
 * Classify purchase orders for UI (coil kg vs stone metres vs accessories).
 * @param {string[]} productIds
 * @returns {'coil' | 'stone' | 'accessory'}
 */
export function deriveProcurementKindFromProductIds(productIds) {
  const ids = (productIds || []).map((x) => String(x ?? '').trim()).filter(Boolean);
  if (ids.length === 0) return 'coil';
  if (ids.every((id) => /^STONE-/i.test(id))) return 'stone';
  if (ids.every((id) => /^ACC-/i.test(id))) return 'accessory';
  return 'coil';
}

/**
 * @param {object | null} dbRow raw purchase_orders row
 * @param {{ product_id?: string, productID?: string }[]} lines
 */
export function procurementKindFromPoRow(dbRow, lines) {
  const k = String(dbRow?.procurement_kind ?? '').trim().toLowerCase();
  if (k === 'stone' || k === 'accessory' || k === 'coil') return k;
  const pids = (lines || []).map((l) => l.product_id ?? l.productID ?? '').filter(Boolean);
  return deriveProcurementKindFromProductIds(pids);
}
