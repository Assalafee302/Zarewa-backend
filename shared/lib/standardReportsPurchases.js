/**
 * Purchases standard reports — three cuts (received / ordered / paid).
 * Frontend copies via `npm run sync:shared` → src/shared/lib/standardReportsPurchases.js
 */

import { displayCoilNumber, displayDocNumber } from './reportDisplayFormat.js';
import { abbreviateBankName } from './bankAbbreviation.js';

function toIsoDate(value) {
  return String(value || '').slice(0, 10);
}

function procurementKindFromPo(po) {
  const k = String(po?.procurementKind || '').trim().toLowerCase();
  if (k === 'stone' || k === 'accessory' || k === 'coil') return k;
  const pids = (po?.lines || []).map((l) => l.productID).filter(Boolean);
  if (pids.length && pids.every((id) => /^STONE-/i.test(String(id)))) return 'stone';
  if (pids.length && pids.every((id) => /^ACC-/i.test(String(id)))) return 'accessory';
  return 'coil';
}

function poLineValueNgn(line, kind) {
  const qty = Number(line.qtyOrdered) || 0;
  if (kind === 'coil') {
    return Math.round(qty * (Number(line.unitPricePerKgNgn) || 0));
  }
  if (kind === 'stone') {
    return Math.round(qty * (Number(line.unitPriceNgn) || 0));
  }
  return Math.round(qty * (Number(line.unitPriceNgn) || Number(line.unitPricePerKgNgn) || 0));
}

function poTotalValueNgn(po, kind) {
  return (po.lines || []).reduce((s, line) => s + poLineValueNgn(line, kind), 0);
}

/**
 * GRN / coil lots received in period (coil + stone-coated lots).
 */
export function purchasesReceivedRows(coilLots = [], startDate, endDate) {
  const rows = [];
  for (const lot of coilLots || []) {
    const iso = toIsoDate(lot.receivedAtISO);
    if (!iso) continue;
    if (startDate && iso < startDate) continue;
    if (endDate && iso > endDate) continue;
    const pid = String(lot.productID || '').trim();
    const isStone = /^STONE-/i.test(pid) || /stone/i.test(String(lot.materialTypeName || ''));
    const kind = isStone ? 'stone' : 'coil';
    if (kind === 'coil' && /^ACC-/i.test(pid)) continue;
    const w = Number(lot.weightKg ?? lot.currentWeightKg) || 0;
    const unit = Math.round(Number(lot.unitCostNgnPerKg) || 0);
    rows.push({
      receivedDateISO: iso,
      materialKind: kind,
      coilNoDisplay: displayCoilNumber(lot.coilNo),
      coilNoFull: String(lot.coilNo || '').trim() || '—',
      colour: String(lot.colour || '').trim() || '—',
      gauge: String(lot.gaugeLabel || '').trim() || '—',
      supplier: String(lot.supplierName || '').trim() || '—',
      poIdDisplay: displayDocNumber(lot.poID) || '—',
      poIdFull: String(lot.poID || '').trim() || '—',
      weightKg: Math.round(w * 100) / 100,
      unitCostNgnPerKg: unit,
      valueNgn: lot.landedCostNgn != null ? Math.round(Number(lot.landedCostNgn)) : Math.round(unit * w),
    });
  }
  rows.sort((a, b) => a.receivedDateISO.localeCompare(b.receivedDateISO) || a.coilNoFull.localeCompare(b.coilNoFull));
  return rows;
}

/**
 * Purchase orders with line detail (order date in period); coil + stone only.
 */
export function purchasesOrderedRows(purchaseOrders = [], startDate, endDate) {
  const rows = [];
  for (const po of purchaseOrders || []) {
    const iso = toIsoDate(po.orderDateISO);
    if (!iso) continue;
    if (startDate && iso < startDate) continue;
    if (endDate && iso > endDate) continue;
    const kind = procurementKindFromPo(po);
    if (kind === 'accessory') continue;
    const paid = Math.round(Number(po.supplierPaidNgn) || 0);
    const totalVal = poTotalValueNgn(po, kind);
    const poOutstanding = Math.max(0, totalVal - paid);
    const poDisp = displayDocNumber(po.poID) || '—';
    for (const line of po.lines || []) {
      const lv = poLineValueNgn(line, kind);
      rows.push({
        orderDateISO: iso,
        poIdDisplay: poDisp,
        poIdFull: String(po.poID || '').trim() || '—',
        supplier: String(po.supplierName || '').trim() || '—',
        materialKind: kind,
        productName: String(line.productName || line.productID || '').trim() || '—',
        color: String(line.color || '').trim() || '—',
        gauge: String(line.gauge || '').trim() || '—',
        qtyOrdered: Number(line.qtyOrdered) || 0,
        unitPriceNgn:
          kind === 'coil'
            ? Math.round(Number(line.unitPricePerKgNgn) || 0)
            : Math.round(Number(line.unitPriceNgn) || 0),
        lineValueNgn: lv,
        poSupplierPaidNgn: paid,
        poOutstandingNgn: poOutstanding,
        poStatus: String(po.status || '').trim() || '—',
      });
    }
  }
  rows.sort((a, b) => a.orderDateISO.localeCompare(b.orderDateISO) || a.poIdFull.localeCompare(b.poIdFull));
  return rows;
}

/**
 * Supplier payments from treasury (posted date in period).
 */
export function purchasesPaidRows(treasuryMovements = [], startDate, endDate) {
  const PAY_TYPES = new Set(['SUPPLIER_PAYMENT', 'PO_SUPPLIER_PAYMENT']);
  const rows = [];
  for (const t of treasuryMovements || []) {
    if (!PAY_TYPES.has(String(t.type || ''))) continue;
    if (String(t.counterpartyKind || '').toUpperCase() !== 'SUPPLIER') continue;
    const iso = toIsoDate(t.postedAtISO);
    if (!iso) continue;
    if (startDate && iso < startDate) continue;
    if (endDate && iso > endDate) continue;
    const amt = Math.round(Math.abs(Number(t.amountNgn) || 0));
    const isCash = String(t.accountType || '').trim().toLowerCase() === 'cash';
    const bankCode = isCash ? '' : abbreviateBankName(t.bankName);
    rows.push({
      paidDateISO: iso,
      supplier: String(t.counterpartyName || '').trim() || '—',
      amountNgn: amt,
      paymentMethod: isCash ? 'Cash' : 'Bank',
      bankAccount: isCash ? 'Cash' : bankCode || String(t.accountName || '').trim() || '—',
      reference: String(t.reference || '').trim() || '—',
      sourceKind: String(t.sourceKind || '').trim() || '—',
      sourceIdDisplay: displayDocNumber(t.sourceId) || String(t.sourceId || '').trim() || '—',
      sourceIdFull: String(t.sourceId || '').trim() || '—',
    });
  }
  rows.sort((a, b) => a.paidDateISO.localeCompare(b.paidDateISO));
  return rows;
}
