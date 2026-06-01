/**
 * Purchase register — GRN receipts in period by material type and gauge,
 * with PO order qty, costing, and supplier payment / outstanding summary.
 */

import { displayCoilNumber, displayDocNumber, displayTxnDateShort } from './reportDisplayFormat.js';
import { purchasesPaidRows } from './standardReportsPurchases.js';

function coilMaterialFamily(materialTypeName) {
  const k = normKey(materialTypeName);
  if (!k) return null;
  if (k.includes('aluzinc')) return 'aluzinc';
  if (k.includes('aluminium') || k.includes('aluminum') || k === 'alu') return 'aluminium';
  return null;
}

const ACCESSORY_TYPES = [
  { key: 'nails_fasteners', label: 'Nails & fasteners', patterns: [/nail/i, /fastener/i] },
  { key: 'screws_clips', label: 'Screws & clips', patterns: [/screw/i, /clip/i] },
  { key: 'ridge_cap', label: 'Ridge & cap', patterns: [/ridge/i, /\bcap\b/i] },
  { key: 'flashing_trim', label: 'Flashing & trim', patterns: [/flash/i, /trim/i] },
  { key: 'sealants', label: 'Sealants', patterns: [/silicone/i, /sealant/i] },
  { key: 'other', label: 'Other', patterns: [] },
];

const GRN_STONE = new Set(['STORE_GRN_STONE', 'STORE_GRN_STONE_FLATSHEET']);
const GRN_ACCESSORY = 'STORE_GRN_ACCESSORY';

function toIsoDate(v) {
  return String(v || '').slice(0, 10);
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function rowDateFields(iso) {
  const txnDate = toIsoDate(iso);
  return { txnDate, txnDateDisplay: displayTxnDateShort(txnDate) };
}

function dateInPeriod(iso, startDate, endDate) {
  const d = toIsoDate(iso);
  if (!d) return false;
  return (!startDate || d >= startDate) && (!endDate || d <= endDate);
}

function normKey(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function colourAbbrevForReport(masterData, rawColour) {
  const raw = String(rawColour || '').trim();
  if (!raw) return '—';
  const colours = masterData?.colours || [];
  const nk = normKey(raw);
  for (const c of colours) {
    const abbr = String(c.abbreviation || '').trim();
    const name = String(c.name || '').trim();
    if (abbr && normKey(abbr) === nk) return abbr;
    if (name && normKey(name) === nk) return abbr || name.slice(0, 4).toUpperCase();
  }
  if (raw.length <= 5 && /^[A-Za-z]+$/.test(raw)) return raw.toUpperCase();
  return raw.slice(0, 5).toUpperCase();
}

function gaugeSortKey(gaugeLabel) {
  const m = String(gaugeLabel || '').match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : 999;
}

function accessoryTypeKey(name) {
  const n = String(name || '');
  for (const t of ACCESSORY_TYPES) {
    if (t.key === 'other') continue;
    if (t.patterns.some((p) => p.test(n))) return t.key;
  }
  return 'other';
}

function accessoryTypeLabel(key) {
  return ACCESSORY_TYPES.find((t) => t.key === key)?.label || 'Other';
}

function familyFromLot(lot) {
  const fam = coilMaterialFamily(lot.materialTypeName);
  if (fam) return fam;
  const pid = String(lot.productID || '').trim().toUpperCase();
  if (pid === 'PRD-102') return 'aluzinc';
  if (pid === 'COIL-ALU') return 'aluminium';
  return 'unclassified';
}

function poLineValueNgn(line, kind) {
  const qty = Number(line.qtyOrdered) || 0;
  if (kind === 'coil') return Math.round(qty * (Number(line.unitPricePerKgNgn) || 0));
  return Math.round(qty * (Number(line.unitPriceNgn) || Number(line.unitPricePerKgNgn) || 0));
}

function poTotalValueNgn(po) {
  const kind = String(po.procurementKind || 'coil').toLowerCase();
  return (po.lines || []).reduce((s, line) => {
    const k = kind === 'mixed' ? lineKindFromProduct(line.productID) : kind;
    return s + poLineValueNgn(line, k === 'stone' ? 'stone' : k === 'accessory' ? 'accessory' : 'coil');
  }, 0);
}

function lineKindFromProduct(productID) {
  const pid = String(productID || '').trim();
  if (/^STONE-/i.test(pid)) return 'stone';
  if (/^ACC-/i.test(pid)) return 'accessory';
  return 'coil';
}

function buildPoMaps(purchaseOrders) {
  const poById = new Map();
  const lineByPoLine = new Map();
  for (const po of purchaseOrders || []) {
    const id = String(po.poID || '').trim();
    if (!id) continue;
    poById.set(id, po);
    for (const line of po.lines || []) {
      lineByPoLine.set(`${id}|${line.lineKey}`, line);
    }
  }
  return { poById, lineByPoLine };
}

function buildProductMap(products) {
  return new Map((products || []).map((p) => [String(p.productID || '').trim(), p]));
}

function parseReceiptRefFromDetail(detail) {
  const d = String(detail || '').trim();
  const m = d.match(/^([A-Z]{2,3}-[^\s·]+)/);
  return m ? m[1] : d.split('·')[0]?.trim() || '—';
}

function buildCoilReceiptRow(lot, po, line, masterData) {
  const receivedKg = round2(Number(lot.weightKg ?? lot.qtyReceived) || 0);
  const orderKg = line ? round2(Number(line.qtyOrdered) || 0) : null;
  const unitKg = Math.round(Number(lot.unitCostNgnPerKg) || 0);
  const totalNgn =
    lot.landedCostNgn != null
      ? Math.round(Number(lot.landedCostNgn))
      : unitKg > 0 && receivedKg > 0
        ? Math.round(unitKg * receivedKg)
        : 0;
  const poId = String(lot.poID || '').trim();
  const remarks = [];
  if (line && orderKg > 0 && receivedKg + 0.01 < orderKg) {
    const lineRecv = round2(Number(line.qtyReceived) || 0);
    if (lineRecv < orderKg) remarks.push(`PO line recv ${lineRecv} / ${orderKg} kg`);
  }
  if (String(lot.currentStatus || '').toLowerCase() === 'consumed') remarks.push('Coil consumed');
  const dates = rowDateFields(lot.receivedAtISO);
  return {
    ...dates,
    supplier: String(lot.supplierName || po?.supplierName || '').trim() || '—',
    coilNo: String(lot.coilNo || '').trim(),
    coilNoDisplay: displayCoilNumber(lot.coilNo) || '—',
    colour: colourAbbrevForReport(masterData, lot.colour),
    gauge: String(lot.gaugeLabel || line?.gauge || '').trim() || '—',
    receivedKg,
    orderKg,
    kgAmountNgn: unitKg || null,
    totalNgn,
    poIdDisplay: displayDocNumber(poId) || '—',
    poId: poId || '—',
    productName: String(line?.productName || lot.productID || '').trim() || '—',
    remark: remarks.length ? remarks.join(' · ') : '—',
  };
}

function buildMovementReceiptRow(m, po, line, product, masterData, kind) {
  const qty = round2(Math.abs(Number(m.qty) || 0));
  const orderQty = line ? round2(Number(line.qtyOrdered) || 0) : null;
  const unitNgn = Math.round(Number(m.unitPriceNgn) || 0);
  const totalNgn =
    m.valueNgn != null ? Math.round(Number(m.valueNgn)) : unitNgn > 0 && qty > 0 ? Math.round(unitNgn * qty) : 0;
  const poId = String(m.ref || '').trim();
  const isFs = m.type === 'STORE_GRN_STONE_FLATSHEET';
  const unitLabel = kind === 'accessory' ? 'units' : isFs ? 'sheets' : 'm';
  const remarks = [];
  if (line && orderQty > 0 && qty + 0.01 < orderQty) {
    const lineRecv = round2(Number(line.qtyReceived) || 0);
    if (lineRecv < orderQty) remarks.push(`PO line recv ${lineRecv} / ${orderQty} ${unitLabel}`);
  }
  const receiptRef = parseReceiptRefFromDetail(m.detail);
  const dates = rowDateFields(m.dateISO || m.atISO);
  return {
    ...dates,
    supplier: String(po?.supplierName || '').trim() || '—',
    coilNo: receiptRef,
    coilNoDisplay: receiptRef.length > 12 ? receiptRef.slice(-12) : receiptRef,
    colour: colourAbbrevForReport(masterData, line?.color || product?.dashboardAttrs?.colour),
    gauge: String(line?.gauge || product?.dashboardAttrs?.gauge || '').trim() || '—',
    receivedQty: qty,
    orderQty,
    unitLabel,
    kgAmountNgn: unitNgn || null,
    totalNgn,
    poIdDisplay: displayDocNumber(poId) || '—',
    poId: poId || '—',
    productName: String(line?.productName || product?.name || m.productID || '').trim() || '—',
    remark: remarks.length ? remarks.join(' · ') : '—',
  };
}

function summarizeReceiptRows(rows, valueKey = 'totalNgn') {
  let totalValue = 0;
  let totalReceived = 0;
  for (const r of rows) {
    totalValue += Number(r[valueKey]) || 0;
    totalReceived += Number(r.receivedKg ?? r.receivedQty) || 0;
  }
  return {
    lineCount: rows.length,
    totalReceived: round2(totalReceived),
    totalValueNgn: Math.round(totalValue),
  };
}

function groupCoilReceiptsByGauge(rows) {
  const byGauge = new Map();
  for (const r of rows) {
    const g = r.gauge || '—';
    if (!byGauge.has(g)) byGauge.set(g, []);
    byGauge.get(g).push(r);
  }
  return [...byGauge.entries()]
    .sort((a, b) => gaugeSortKey(a[0]) - gaugeSortKey(b[0]) || String(a[0]).localeCompare(String(b[0])))
    .map(([gaugeLabel, gaugeRows]) => {
      gaugeRows.sort(
        (a, b) =>
          String(a.txnDate).localeCompare(String(b.txnDate)) ||
          String(a.coilNo).localeCompare(String(b.coilNo), undefined, { numeric: true })
      );
      return { gaugeLabel, rows: gaugeRows, subtotals: summarizeReceiptRows(gaugeRows) };
    });
}

function groupAccessoryReceipts(rows) {
  const byType = new Map();
  for (const r of rows) {
    const k = accessoryTypeKey(r.productName);
    if (!byType.has(k)) byType.set(k, []);
    byType.get(k).push(r);
  }
  return [...byType.entries()]
    .sort((a, b) => accessoryTypeLabel(a[0]).localeCompare(accessoryTypeLabel(b[0])))
    .map(([typeKey, typeRows]) => ({
      typeKey,
      typeLabel: accessoryTypeLabel(typeKey),
      rows: typeRows.sort((a, b) => String(a.txnDate).localeCompare(String(b.txnDate))),
      subtotals: summarizeReceiptRows(typeRows),
    }));
}

function collectPoIdsFromReport(sections) {
  const ids = new Set();
  for (const sec of sections) {
    for (const g of sec?.groups || []) {
      for (const r of g.rows || []) {
        if (r.poId && r.poId !== '—') ids.add(r.poId);
      }
    }
  }
  return ids;
}

function buildPoPaymentRows(poById, poIds, paymentsByPo) {
  const rows = [];
  for (const poId of [...poIds].sort()) {
    const po = poById.get(poId);
    if (!po) continue;
    const totalVal = poTotalValueNgn(po);
    const paid = Math.round(Number(po.supplierPaidNgn) || 0);
    const paidInPeriod = Math.round(paymentsByPo.get(poId) || 0);
    const outstanding = Math.max(0, totalVal - paid);
    rows.push({
      poIdDisplay: displayDocNumber(poId) || '—',
      poId,
      supplier: String(po.supplierName || '').trim() || '—',
      orderDate: toIsoDate(po.orderDateISO),
      status: String(po.status || '').trim() || '—',
      poValueNgn: totalVal,
      supplierPaidNgn: paid,
      paidInPeriodNgn: paidInPeriod,
      outstandingNgn: outstanding,
      remark: outstanding > 0 ? 'Balance due supplier' : paid >= totalVal && totalVal > 0 ? 'Fully paid' : '—',
    });
  }
  rows.sort((a, b) => String(a.supplier).localeCompare(String(b.supplier)) || String(a.poId).localeCompare(String(b.poId)));
  return rows;
}

export function buildPurchaseReportSummary(report) {
  const byMaterial = [];
  const push = (label, key, section, isCoil = true) => {
    const t = section?.totals;
    if (!t?.lineCount) return;
    byMaterial.push({
      key,
      label,
      lineCount: t.lineCount,
      received: t.totalReceived,
      receivedUnit: isCoil ? 'kg' : section.receivedUnit || '—',
      totalValueNgn: t.totalValueNgn,
    });
  };
  push('Aluminium', 'aluminium', report.aluminium, true);
  push('Aluzinc', 'aluzinc', report.aluzinc, true);
  push('Coil (unclassified)', 'unclassified', report.unclassifiedCoil, true);
  push('Stone-coated', 'stone', report.stoneCoated, false);
  push('Accessories', 'accessories', report.accessories, false);

  const byGauge = [];
  for (const [mat, sec] of [
    ['Aluminium', report.aluminium],
    ['Aluzinc', report.aluzinc],
    ['Coil (unclassified)', report.unclassifiedCoil],
    ['Stone-coated', report.stoneCoated],
  ]) {
    for (const g of sec?.groups || []) {
      byGauge.push({
        material: mat,
        gaugeLabel: g.gaugeLabel,
        lineCount: g.subtotals.lineCount,
        received: g.subtotals.totalReceived,
        receivedUnit: sec.receivedUnit || 'kg',
        totalValueNgn: g.subtotals.totalValueNgn,
      });
    }
  }
  for (const g of report.accessories?.groups || []) {
    byGauge.push({
      material: 'Accessories',
      gaugeLabel: g.typeLabel,
      lineCount: g.subtotals.lineCount,
      received: g.subtotals.totalReceived,
      receivedUnit: 'units',
      totalValueNgn: g.subtotals.totalValueNgn,
    });
  }

  const paidInPeriod = report.payments?.supplierPayments?.reduce((s, p) => s + (Number(p.amountNgn) || 0), 0) || 0;
  const poOutstanding = (report.payments?.poBalances || []).reduce((s, p) => s + (Number(p.outstandingNgn) || 0), 0);
  const receivedValue = byMaterial.reduce((s, m) => s + (Number(m.totalValueNgn) || 0), 0);

  const observations = [];
  const recommendations = [];
  const shortLines = (report.payments?.poBalances || []).filter((p) => p.outstandingNgn > 0);
  if (shortLines.length) {
    observations.push(
      `${shortLines.length} purchase order(s) in this report still show supplier balance outstanding (₦${poOutstanding.toLocaleString()} total).`
    );
    recommendations.push('Clear supplier payables on outstanding POs or confirm accrual with Finance.');
  }
  if (paidInPeriod > 0) {
    observations.push(`Supplier treasury payments in period: ₦${paidInPeriod.toLocaleString()} (${report.payments?.supplierPayments?.length || 0} posting(s)).`);
  }
  if (receivedValue > 0) {
    observations.push(`Goods received value in period (GRN): ₦${receivedValue.toLocaleString()} across ${byMaterial.reduce((s, m) => s + m.lineCount, 0)} receipt line(s).`);
  }
  if (!observations.length) {
    observations.push('No GRN receipts or supplier payments recorded in this period.');
  }

  return {
    byMaterial,
    byGauge,
    payments: {
      receivedValueNgn: receivedValue,
      paidInPeriodNgn: paidInPeriod,
      poOutstandingNgn: poOutstanding,
    },
    observations,
    recommendations,
  };
}

/**
 * @param {object} input
 * @param {object[]} input.purchaseOrders
 * @param {object[]} input.coilLots
 * @param {object[]} input.stockMovements
 * @param {object[]} input.treasuryMovements
 * @param {object[]} [input.products]
 * @param {object} [input.masterData]
 * @param {string} [input.startDate]
 * @param {string} [input.endDate]
 */
export function buildPurchaseReport(input = {}) {
  const {
    purchaseOrders = [],
    coilLots = [],
    stockMovements = [],
    treasuryMovements = [],
    products = [],
    masterData = null,
    startDate,
    endDate,
  } = input;

  const { poById, lineByPoLine } = buildPoMaps(purchaseOrders);
  const productById = buildProductMap(products);

  const aluRows = [];
  const aluzRows = [];
  const unclRows = [];
  const stoneRows = [];
  const accRows = [];

  for (const lot of coilLots || []) {
    const iso = toIsoDate(lot.receivedAtISO);
    if (!dateInPeriod(iso, startDate, endDate)) continue;
    const pid = String(lot.productID || '').trim();
    if (/^ACC-/i.test(pid)) continue;
    if (/^STONE-/i.test(pid)) continue;
    const poId = String(lot.poID || '').trim();
    const line = poId ? lineByPoLine.get(`${poId}|${lot.lineKey}`) : null;
    const po = poId ? poById.get(poId) : null;
    const row = buildCoilReceiptRow(lot, po, line, masterData);
    const fam = familyFromLot(lot);
    if (fam === 'aluzinc') aluzRows.push(row);
    else if (fam === 'aluminium') aluRows.push(row);
    else unclRows.push(row);
  }

  for (const m of stockMovements || []) {
    const iso = toIsoDate(m.dateISO || m.atISO);
    if (!dateInPeriod(iso, startDate, endDate)) continue;
    const poId = String(m.ref || '').trim();
    const po = poId ? poById.get(poId) : null;
    let line = null;
    if (po && m.productID) {
      line = (po.lines || []).find((l) => String(l.productID) === String(m.productID)) || null;
    }
    const product = m.productID ? productById.get(String(m.productID)) : null;

    if (GRN_STONE.has(m.type)) {
      stoneRows.push(buildMovementReceiptRow(m, po, line, product, masterData, 'stone'));
    } else if (m.type === GRN_ACCESSORY) {
      accRows.push(buildMovementReceiptRow(m, po, line, product, masterData, 'accessory'));
    }
  }

  const wrapCoil = (rows) => ({
    receivedUnit: 'kg',
    groups: groupCoilReceiptsByGauge(rows),
    totals: summarizeReceiptRows(rows),
  });

  const stoneSection = {
    receivedUnit: 'm',
    groups: groupCoilReceiptsByGauge(stoneRows),
    totals: summarizeReceiptRows(stoneRows),
  };

  const accSection = {
    receivedUnit: 'units',
    groups: groupAccessoryReceipts(accRows),
    totals: summarizeReceiptRows(accRows),
  };

  const body = {
    period: { startDate: startDate || '', endDate: endDate || '' },
    aluminium: wrapCoil(aluRows),
    aluzinc: wrapCoil(aluzRows),
    unclassifiedCoil: wrapCoil(unclRows),
    stoneCoated: stoneSection,
    accessories: accSection,
  };

  const poIds = collectPoIdsFromReport([
    body.aluminium,
    body.aluzinc,
    body.unclassifiedCoil,
    body.stoneCoated,
    body.accessories,
  ]);

  const paymentsByPo = new Map();
  const supplierPayments = purchasesPaidRows(treasuryMovements, startDate, endDate);
  for (const p of supplierPayments) {
    const pid = String(p.sourceIdFull || '').trim();
    if (pid) paymentsByPo.set(pid, (paymentsByPo.get(pid) || 0) + (Number(p.amountNgn) || 0));
  }

  body.payments = {
    supplierPayments,
    poBalances: buildPoPaymentRows(poById, poIds, paymentsByPo),
    totals: {
      paidInPeriodNgn: supplierPayments.reduce((s, p) => s + (Number(p.amountNgn) || 0), 0),
      poOutstandingNgn: buildPoPaymentRows(poById, poIds, paymentsByPo).reduce(
        (s, p) => s + (Number(p.outstandingNgn) || 0),
        0
      ),
    },
  };

  body.summary = buildPurchaseReportSummary(body);
  return body;
}
