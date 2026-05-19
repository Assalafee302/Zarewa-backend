import {
  deriveProcurementKindFromLineTypes,
  deriveProcurementKindFromPoLines,
  inferLineTypeFromProduct,
} from '../shared/lib/poLineTypes.js';

/**
 * Classify purchase orders for UI (coil kg vs stone metres vs accessories).
 * @param {string[]} productIds
 * @returns {'coil' | 'stone' | 'accessory' | 'mixed'}
 */
export function deriveProcurementKindFromProductIds(productIds) {
  const ids = (productIds || []).map((x) => String(x ?? '').trim()).filter(Boolean);
  if (ids.length === 0) return 'coil';
  const lineTypes = ids.map((id) => inferLineTypeFromProduct(id));
  return deriveProcurementKindFromLineTypes(lineTypes);
}

/**
 * @param {object | null} dbRow raw purchase_orders row
 * @param {{ product_id?: string, productID?: string }[]} lines
 */
export function procurementKindFromPoRow(dbRow, lines) {
  const k = String(dbRow?.procurement_kind ?? '').trim().toLowerCase();
  if (k === 'stone' || k === 'accessory' || k === 'coil' || k === 'mixed') return k;
  if (lines?.length) {
    return deriveProcurementKindFromPoLines(
      lines.map((l) => ({
        lineType: l.line_type ?? l.lineType,
        productID: l.product_id ?? l.productID,
        metersOffered: l.meters_offered ?? l.metersOffered,
        qtyOrdered: l.qty_ordered ?? l.qtyOrdered,
        unitPricePerKgNgn: l.unit_price_per_kg_ngn ?? l.unitPricePerKgNgn,
      }))
    );
  }
  const pids = (lines || []).map((l) => l.product_id ?? l.productID ?? '').filter(Boolean);
  return deriveProcurementKindFromProductIds(pids);
}

/** @param {{ lineType?: string; line_type?: string; productID?: string; product_id?: string }} line */
export function lineKindForGrn(line) {
  const lt = String(line?.lineType ?? line?.line_type ?? '').trim();
  if (lt === 'stone_meter') return 'stone';
  if (lt === 'stone_flatsheet') return 'stone_flatsheet';
  if (lt === 'accessory') return 'accessory';
  if (lt === 'coil_meter' || lt === 'coil_kg') return 'coil';
  const pid = String(line?.productID ?? line?.product_id ?? '').trim();
  return inferLineTypeFromProduct(pid, null, line) === 'stone_flatsheet'
    ? 'stone_flatsheet'
    : inferLineTypeFromProduct(pid, null, line) === 'stone_meter'
      ? 'stone'
      : inferLineTypeFromProduct(pid, null, line) === 'accessory'
        ? 'accessory'
        : 'coil';
}
