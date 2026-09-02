/**
 * Per-coil reconciliation: opening + purchased − consumed vs. closing.
 * Cross-checks the Purchase register, Material transaction register, and
 * Closing stock report against each other, coil by coil, instead of leaving
 * a reader to eyeball three separate reports and hope the numbers agree.
 * Frontend copy via `npm run sync:shared` -> src/shared/lib/coilStockTieOut.js
 */

import { stockCoilAsAtRows } from './standardReportsStock.js';
import { purchasesReceivedRows } from './standardReportsPurchases.js';

const TOLERANCE_KG = 0.5;

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Flattens `buildMaterialTransactionReport(...)`'s coil sections
 * (aluminium / aluzinc / unclassifiedCoil, each grouped by gauge) into a
 * flat list of { coilNo, kgUsed } consumption lines.
 * @param {object} materialTransactionReport - output of buildMaterialTransactionReport
 */
export function flattenMaterialTransactionCoilRows(materialTransactionReport) {
  const sections = [
    materialTransactionReport?.aluminium,
    materialTransactionReport?.aluzinc,
    materialTransactionReport?.unclassifiedCoil,
  ];
  const rows = [];
  for (const section of sections) {
    for (const group of section?.groups || []) {
      for (const row of group?.rows || []) {
        rows.push({ coilNo: String(row.coilNo || '').trim(), kgUsed: Number(row.kgUsed) || 0 });
      }
    }
  }
  return rows;
}

function sumKgByCoil(rows, coilKey, valueKey) {
  const m = new Map();
  for (const r of rows || []) {
    const no = String(r[coilKey] || '').trim();
    if (!no || no === '—') continue;
    m.set(no, (m.get(no) || 0) + (Number(r[valueKey]) || 0));
  }
  return m;
}

/**
 * @param {object} input
 * @param {object[]} input.openingSnapshotLots - coil lots/snapshot rows as-at the day BEFORE the period start (previous month-end close); [] if unknown
 * @param {boolean} input.openingKnown - false if no snapshot exists for the opening date (falls back silently to 0 otherwise, which would misreport every carried-over coil as a mismatch)
 * @param {object[]} input.closingSnapshotLots - coil lots/snapshot rows as-at the period end (this period's close); [] if unknown
 * @param {boolean} input.closingKnown - false if no snapshot exists for the closing date
 * @param {object[]} input.coilLotsReceivedInPeriod - coil lots (listCoilLots shape) whose receivedAtISO falls in the period
 * @param {string} input.startDate
 * @param {string} input.endDate
 * @param {object} input.materialTransactionReport - output of buildMaterialTransactionReport for the same period
 * @returns {{ rows: object[], summary: object }}
 */
export function coilStockTieOutRows({
  openingSnapshotLots = [],
  openingKnown = true,
  closingSnapshotLots = [],
  closingKnown = true,
  coilLotsReceivedInPeriod = [],
  startDate,
  endDate,
  materialTransactionReport = null,
} = {}) {
  const openingRows = stockCoilAsAtRows(openingSnapshotLots);
  const closingRows = stockCoilAsAtRows(closingSnapshotLots);
  const openingByCoil = new Map(openingRows.map((r) => [r.coilNoFull, r]));
  const closingByCoil = new Map(closingRows.map((r) => [r.coilNoFull, r]));

  const purchaseRows = purchasesReceivedRows(coilLotsReceivedInPeriod, startDate, endDate);
  const purchasedByCoil = sumKgByCoil(purchaseRows, 'coilNoFull', 'weightKg');
  const purchaseDisplayByCoil = new Map(purchaseRows.map((r) => [r.coilNoFull, r]));

  const consumptionRows = flattenMaterialTransactionCoilRows(materialTransactionReport);
  const consumedByCoil = sumKgByCoil(consumptionRows, 'coilNo', 'kgUsed');

  const allCoilNos = new Set([
    ...openingByCoil.keys(),
    ...closingByCoil.keys(),
    ...purchasedByCoil.keys(),
    ...consumedByCoil.keys(),
  ]);

  const rows = [...allCoilNos].map((coilNo) => {
    const openingRow = openingByCoil.get(coilNo);
    const closingRow = closingByCoil.get(coilNo);
    const purchaseRow = purchaseDisplayByCoil.get(coilNo);
    const display = closingRow || openingRow || purchaseRow || {};

    const openingKg = round2(openingRow?.balanceKg ?? 0);
    const purchasedKg = round2(purchasedByCoil.get(coilNo) ?? 0);
    const consumedKg = round2(consumedByCoil.get(coilNo) ?? 0);
    const closingKg = round2(closingRow?.balanceKg ?? 0);
    const expectedClosingKg = round2(openingKg + purchasedKg - consumedKg);
    const varianceKg = round2(closingKg - expectedClosingKg);

    let status = 'ok';
    if (!openingKnown || !closingKnown) status = 'unverified';
    else if (Math.abs(varianceKg) > TOLERANCE_KG) status = 'mismatch';

    return {
      coilNo,
      coilNoDisplay: display.coilNoDisplay || coilNo,
      colour: display.colour || '—',
      gauge: display.gauge || '—',
      materialType: display.materialType || '—',
      openingKg,
      purchasedKg,
      consumedKg,
      expectedClosingKg,
      closingKg,
      varianceKg,
      status,
    };
  });

  rows.sort((a, b) => {
    const order = { mismatch: 0, unverified: 1, ok: 2 };
    return (order[a.status] ?? 3) - (order[b.status] ?? 3) || a.coilNo.localeCompare(b.coilNo);
  });

  const summary = {
    rowCount: rows.length,
    mismatchCount: rows.filter((r) => r.status === 'mismatch').length,
    unverifiedCount: rows.filter((r) => r.status === 'unverified').length,
    okCount: rows.filter((r) => r.status === 'ok').length,
    totalVarianceKg: round2(
      rows.filter((r) => r.status === 'mismatch').reduce((s, r) => s + Math.abs(r.varianceKg), 0)
    ),
    openingKnown,
    closingKnown,
  };

  return { rows, summary };
}
