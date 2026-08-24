/**
 * Coil kg purchased vs weighbridge kg received — supplier scorecard.
 * Frontend copies via `npm run sync:shared` → src/shared/lib/supplierCoilReceiptVariance.js
 */
import { coilReceivedKg } from './coilStockKg.js';
import { deriveProcurementKindFromPoLines, inferLineTypeFromProduct } from './poLineTypes.js';

function roundKg(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function isCoilKgLine(line) {
  const lt = inferLineTypeFromProduct(line?.productID ?? line?.product_id, null, line);
  return lt === 'coil_kg';
}

/**
 * @param {{
 *   purchaseOrders?: object[];
 *   coilLots?: object[];
 *   supplierId?: string;
 * }} args
 */
export function buildSupplierCoilReceiptVariance({
  purchaseOrders = [],
  coilLots = [],
  supplierId,
} = {}) {
  const sid = String(supplierId || '').trim();
  const orders = (purchaseOrders || []).filter((p) => {
    if (String(p.status || '').toLowerCase() === 'rejected') return false;
    return !sid || String(p.supplierID || p.supplier_id || '').trim() === sid;
  });
  const orderIds = new Set(orders.map((p) => String(p.poID || p.po_id || '').trim()).filter(Boolean));

  const lots = (coilLots || []).filter((lot) => {
    const lotSid = String(lot.supplierID || lot.supplier_id || '').trim();
    if (sid && lotSid && lotSid === sid) return true;
    const poId = String(lot.poID || lot.po_id || '').trim();
    return poId && orderIds.has(poId);
  });

  const landedByPo = new Map();
  for (const lot of lots) {
    const poId = String(lot.poID || lot.po_id || '').trim();
    if (!poId) continue;
    landedByPo.set(poId, roundKg((landedByPo.get(poId) || 0) + coilReceivedKg(lot)));
  }

  let orderedKg = 0;
  let landedKg = 0;
  let shortKg = 0;
  const shortPos = [];

  for (const po of orders) {
    const poId = String(po.poID || po.po_id || '').trim();
    const kind = deriveProcurementKindFromPoLines(po.lines || []);
    if (kind !== 'coil' && kind !== 'mixed') continue;
    let poOrdered = 0;
    for (const line of po.lines || []) {
      if (!isCoilKgLine(line)) continue;
      poOrdered += Math.max(0, Number(line.qtyOrdered ?? line.qty_ordered) || 0);
    }
    if (poOrdered <= 0) continue;
    const poLanded = landedByPo.get(poId) || 0;
    orderedKg += poOrdered;
    landedKg += poLanded;
    const poShort = poLanded > 0 ? Math.max(0, roundKg(poOrdered - poLanded)) : 0;
    if (poLanded > 0 && poShort > 0.5) {
      shortKg += poShort;
      shortPos.push({
        poID: poId,
        orderDateISO: po.orderDateISO || po.order_date_iso || '',
        status: po.status || '',
        orderedKg: roundKg(poOrdered),
        landedKg: roundKg(poLanded),
        shortKg: poShort,
        shortPct: poOrdered > 0 ? (poShort / poOrdered) * 100 : 0,
      });
    }
  }

  const receivedOrderedKg = shortPos.reduce((s, r) => s + r.orderedKg, 0) +
    (orderedKg - shortPos.reduce((s, r) => s + r.orderedKg, 0));
  const fulfillmentPct =
    orderedKg > 0 ? Math.round((Math.min(landedKg, orderedKg) / orderedKg) * 100) : 0;

  return {
    orderedKg: roundKg(orderedKg),
    landedKg: roundKg(landedKg),
    shortKg: roundKg(shortKg),
    shortPoCount: shortPos.length,
    fulfillmentPct,
    receivedOrderedKg: roundKg(receivedOrderedKg),
    shortPos: shortPos.sort((a, b) => b.shortKg - a.shortKg),
  };
}
