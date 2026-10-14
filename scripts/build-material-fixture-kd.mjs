#!/usr/bin/env node
/**
 * Build the Kaduna Sep 2026 material-register fixture from an ERP "all entered data" export (.xlsx).
 * Reads the workbook only; no database access.
 *
 *   node scripts/build-material-fixture-kd.mjs <export.xlsx> [out.json]
 *
 * Not in the export (report sections that need them are tested with synthetic data):
 * production_job_coils (job ↔ coil opening/closing/consumed kg), accessory usage, master data.
 */
import fs from 'node:fs';
import path from 'node:path';
import XLSX from 'xlsx';

const src = process.argv[2];
const out =
  process.argv[3] || path.join(process.cwd(), 'shared/lib/__fixtures__/kd-2026-09/materialRegisterSource.json');
if (!src) {
  console.error('Usage: node scripts/build-material-fixture-kd.mjs <export.xlsx> [out.json]');
  process.exit(1);
}

const wb = XLSX.readFile(src);
const sheet = (name) => {
  const ws = wb.Sheets[name];
  if (!ws) throw new Error(`Sheet ${name} missing from ${src}`);
  return XLSX.utils.sheet_to_json(ws, { defval: '' });
};
const pick = (row, keys) => Object.fromEntries(keys.map((k) => [k, row[k]]));
const meta = Object.fromEntries(sheet('Summary').map((r) => Object.values(r).slice(0, 2)));

const coilLots = sheet('Coil_lots').map((c) =>
  pick(c, [
    'coilNo', 'productID', 'colour', 'gaugeLabel', 'materialTypeName', 'weightKg', 'qtyReceived', 'currentWeightKg',
    'currentStatus', 'supplierName', 'poID', 'receivedAtISO', 'landedCostNgn', 'unitCostNgnPerKg',
  ])
);

const STOCK_TYPES = new Set([
  'COIL_CONSUMPTION', 'COIL_SCRAP', 'COIL_RETURN', 'STORE_GRN', 'ADJUSTMENT',
  'STONE_CONSUMPTION', 'STORE_GRN_STONE', 'STONE_FLATSHEET_ISSUE', 'STONE_FLATSHEET_ISSUE_ADJUSTMENT', 'STORE_GRN_STONE_FLATSHEET',
]);
const stockMovements = sheet('Stock_movements')
  .filter((m) => STOCK_TYPES.has(m.type))
  .map((m) => pick(m, ['id', 'dateISO', 'atISO', 'type', 'ref', 'productID', 'qty', 'detail', 'unitPriceNgn', 'valueNgn']));

const poLines = sheet('PO_lines');
const purchaseOrders = sheet('Purchase_orders').map((po) => ({
  ...pick(po, ['poID', 'supplierName', 'orderDateISO', 'status', 'procurementKind']),
  lines: poLines
    .filter((l) => l.poID === po.poID)
    .map((l) => pick(l, ['lineKey', 'lineType', 'productID', 'productName', 'color', 'gauge', 'qtyOrdered', 'qtyReceived', 'unitPriceNgn', 'unitPricePerKgNgn'])),
}));

const productionJobs = sheet('Production_jobs').map((j) =>
  pick(j, [
    'jobID', 'cuttingListId', 'quotationRef', 'customerName', 'productID', 'productName', 'plannedMeters', 'actualMeters',
    'effectiveOutputMeters', 'actualWeightKg', 'status', 'startDateISO', 'endDateISO', 'completedAtISO',
  ])
);

const quotations = sheet('Quotations').map((q) => ({
  ...pick(q, ['id', 'customerID', 'customer', 'dateISO', 'totalNgn', 'paidNgn', 'status', 'projectName', 'materialGauge', 'materialColor', 'materialDesign', 'materialTypeId']),
  stoneMeterQuote: /^(yes|true|1)$/i.test(String(q.stoneMeterQuote)),
}));

const refunds = sheet('Refunds').map((r) => pick(r, ['refundID', 'quotationRef', 'status', 'paidAmountNgn']));

const products = sheet('Products').map((p) => pick(p, ['productID', 'name', 'unit', 'materialType']));

const fixture = {
  _meta: {
    source: `ERP export ${path.basename(src)} (branch scope ${meta['Branch scope'] || '?'}, generated ${meta.Generated || '?'}). Columns trimmed to what the material register reads.`,
    missingFromExport: ['productionJobCoils', 'accessoryUsage', 'masterData'],
  },
  branch: { id: meta['Branch scope'] || 'BR-KD' },
  startDate: '2026-09-01',
  endDate: '2026-09-30',
  coilLots,
  stockMovements,
  purchaseOrders,
  productionJobs,
  quotations,
  refunds,
  products,
};

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(fixture));
console.log(
  `Wrote ${out}: coils ${coilLots.length}, movements ${stockMovements.length}, POs ${purchaseOrders.length}, ` +
    `jobs ${productionJobs.length}, quotations ${quotations.length}, refunds ${refunds.length}`
);
