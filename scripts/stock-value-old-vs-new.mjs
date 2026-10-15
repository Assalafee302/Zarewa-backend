#!/usr/bin/env node
/**
 * Old vs new coil stock value on the Kaduna fixture (ERP export of 13 Oct 2026, live coil weights). No database.
 *   node scripts/stock-value-old-vs-new.mjs [fixture.json]
 * Old formulas are reproduced here as they were before the one-rule change (owner, 15 Oct 2026).
 */
import fs from 'node:fs';
import { coilNetValueRows } from '../shared/lib/coilRegisterCore.js';
import { stockCoilAsAtRows, stockCoilAsAtTotals } from '../shared/lib/standardReportsStock.js';
import { computeInventoryAnalytics } from '../shared/lib/businessIntelligence.js';

const src = process.argv[2] || new URL('../shared/lib/__fixtures__/kd-2026-09/materialRegisterSource.json', import.meta.url);
const kd = JSON.parse(fs.readFileSync(src, 'utf8'));
const lots = (kd.coilLots || []).filter((c) => c.currentStatus !== 'Consumed' && (Number(c.currentWeightKg) || 0) > 0);
const pos = kd.purchaseOrders || [];
const fam = (c) => (/alumin/i.test(c.materialTypeName || '') ? 'aluminium' : /aluzinc|ppgi/i.test(c.materialTypeName || '') ? 'aluzinc' : '');
const n = (v) => Math.round(Number(v) || 0);

// OLD — Coil stock as at / exec dashboard: whole landed cost if present, else unit cost × gross kg.
const oldAsAt = lots.reduce((s, c) => s + (c.landedCostNgn != null ? n(c.landedCostNgn) : c.unitCostNgnPerKg != null ? n(Number(c.unitCostNgnPerKg) * Number(c.currentWeightKg)) : 0), 0);
const oldExec = lots.reduce((s, c) => {
  const kg = Number(c.currentWeightKg) || 0;
  const u = Number(c.unitCostNgnPerKg) || 0;
  return s + (u > 0 && kg > 0 ? n(kg * u) : n(c.landedCostNgn));
}, 0);
// OLD — stock register spool: aluminium 35, aluzinc 60, below 30 kg = net, ≤ spool = 0.
const oldRegNet = (c) => {
  const g = Number(c.currentWeightKg) || 0;
  const sp = { aluminium: 35, aluzinc: 60 }[fam(c)] || 0;
  if (g > 0 && g < 30) return g;
  if (g <= sp) return 0;
  return g - sp;
};
const oldRegValue = lots.reduce((s, c) => s + n(oldRegNet(c) * (Number(c.unitCostNgnPerKg) || 0)), 0);

// NEW — one rule, shared costing.
const rows = coilNetValueRows(lots, pos);
const newValue = rows.reduce((s, r) => s + r.valueNgn, 0);
const asAtNew = stockCoilAsAtTotals(stockCoilAsAtRows(lots, { purchaseOrders: pos })).totalValueNgn;
const inv = computeInventoryAnalytics({ coilLots: lots, purchaseOrders: pos, products: [], stockMovements: [], productionJobs: [], quotations: [] });
const execNew = inv.families.reduce((s, f) => s + f.valuationNgn, 0);
const gross = rows.reduce((s, r) => s + r.grossKg, 0);
const spool = rows.reduce((s, r) => s + r.spoolKg, 0);
const oldRegSpool = lots.reduce((s, c) => s + ((Number(c.currentWeightKg) || 0) - oldRegNet(c)), 0);

const fmt = (v) => `₦${Math.round(v).toLocaleString('en-NG')}`;
console.log(`Kaduna fixture, ${lots.length} coils on hand, ${gross.toLocaleString('en-NG')} kg gross`);
console.log(`spool kg: old stock-register rule ${Math.round(oldRegSpool).toLocaleString('en-NG')} | new one rule ${Math.round(spool).toLocaleString('en-NG')}`);
console.table([
  { total: 'Coil stock as at (live)', old: fmt(oldAsAt), new: fmt(asAtNew), change: fmt(asAtNew - oldAsAt) },
  { total: 'Executive dashboard inventory', old: fmt(oldExec), new: fmt(execNew), change: fmt(execNew - oldExec) },
  { total: 'Stock register (old 35/60/30 rule, coil cost)', old: fmt(oldRegValue), new: fmt(newValue), change: fmt(newValue - oldRegValue) },
  { total: 'Valuation export / month-end report basis', old: '—', new: fmt(newValue), change: '' },
]);
const metre = rows.filter((r) => r.boughtBy === 'metre');
const rateDiff = rows.filter((r) => {
  const lot = lots.find((c) => String(c.coilNo).trim() === r.coilNo);
  return lot && Number(lot.unitCostNgnPerKg) > 0 && Math.abs(r.rateNgnPerKg - Number(lot.unitCostNgnPerKg)) > 1;
});
console.log(`metre-bought coils (no spool): ${metre.length}; coils whose rate differs from the ERP coil cost (metre-bought re-costing): ${rateDiff.length}`);
console.log(`same totals agree: as-at = exec = shared helper → ${asAtNew === newValue && execNew === newValue}`);
