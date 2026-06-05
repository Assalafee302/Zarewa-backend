/**
 * AP2c — inventory valuation reports (accounting + management views).
 */
import { branchWhere } from './readModel.js';
import {
  hasColumn,
  parsePeriodKey,
  roundMoney,
  tableExists,
} from './ap2ReceivedBasisOps.js';
import { readFinanceFeatureFlags } from './financeFeatureFlags.js';

function coilAccountingValue(coil) {
  const landed = roundMoney(coil.landed_cost_ngn);
  if (landed > 0) return { valueNgn: landed, estimated: false, basis: 'landed_cost' };
  const upkg = roundMoney(coil.unit_cost_ngn_per_kg);
  const w = Number(coil.current_weight_kg) || Number(coil.weight_kg) || 0;
  if (upkg > 0 && w > 0) return { valueNgn: roundMoney(upkg * w), estimated: false, basis: 'unit_cost_per_kg' };
  return { valueNgn: 0, estimated: true, basis: 'missing' };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ branchId?: string | null; period?: string | null; materialFamily?: string; gauge?: string; colour?: string; valuationBasis?: string }} [opts]
 */
export function buildInventoryValuationReport(db, opts = {}) {
  const flags = readFinanceFeatureFlags();
  if (!flags.inventoryValuationReportsEnabled) {
    return {
      ok: true,
      status: 'disabled',
      label: 'Inventory valuation report',
      message: 'INVENTORY_VALUATION_REPORTS_ENABLED=0',
    };
  }

  const branchScope =
    opts.branchId && String(opts.branchId).trim() && opts.branchId !== 'ALL'
      ? String(opts.branchId).trim()
      : 'ALL';
  const period = opts.period ? parsePeriodKey(opts.period) : null;
  const periodKey = period?.key || new Date().toISOString().slice(0, 7);

  const notes = [
    'Accounting value uses landed/purchase cost on coil lots.',
    'Replacement/market value is management-only — not configured unless price list data exists.',
    'Not statutory until Head of Accounts sign-off.',
  ];

  if (!tableExists(db, 'coil_lots')) {
    return emptyInventoryReport(branchScope, period, notes);
  }

  let sql = `SELECT c.*, p.branch_id AS po_branch_id
    FROM coil_lots c
    LEFT JOIN purchase_orders p ON p.po_id = c.po_id
    WHERE COALESCE(c.qty_remaining, 0) > 0 OR COALESCE(c.qty_received, 0) > 0`;
  const args = [];
  if (branchScope !== 'ALL' && hasColumn(db, 'purchase_orders', 'branch_id')) {
    sql += ` AND COALESCE(p.branch_id, '') = ?`;
    args.push(branchScope);
  }
  if (opts.materialFamily) {
    sql += ` AND LOWER(COALESCE(c.material_type_name,'')) LIKE ?`;
    args.push(`%${String(opts.materialFamily).trim().toLowerCase()}%`);
  }
  if (opts.gauge) {
    sql += ` AND LOWER(COALESCE(c.gauge_label,'')) LIKE ?`;
    args.push(`%${String(opts.gauge).trim().toLowerCase()}%`);
  }
  if (opts.colour) {
    sql += ` AND LOWER(COALESCE(c.colour,'')) LIKE ?`;
    args.push(`%${String(opts.colour).trim().toLowerCase()}%`);
  }

  const coils = db.prepare(sql).all(...args);

  let accountingValueNgn = 0;
  let estimatedValueNgn = 0;
  let missingCostCount = 0;
  const byBranch = new Map();
  const byMaterial = new Map();
  const byGaugeColour = new Map();
  const missingCostSamples = [];

  for (const c of coils) {
    const { valueNgn, estimated, basis } = coilAccountingValue(c);
    if (basis === 'missing' || valueNgn <= 0) {
      missingCostCount += 1;
      if (missingCostSamples.length < 25) {
        missingCostSamples.push({
          coilNo: c.coil_no,
          poId: c.po_id,
          supplierName: c.supplier_name,
          gauge: c.gauge_label,
          colour: c.colour,
        });
      }
      continue;
    }
    accountingValueNgn += valueNgn;
    if (estimated) estimatedValueNgn += valueNgn;

    const branchId = String(c.po_branch_id || '(none)').trim() || '(none)';
    const mat = String(c.material_type_name || 'Coil').trim();
    const gc = `${c.gauge_label || '—'} / ${c.colour || '—'}`;

    const bump = (map, key, extra = {}) => {
      if (!map.has(key)) map.set(key, { key, accountingValueNgn: 0, coilCount: 0, missingCostCount: 0, ...extra });
      const b = map.get(key);
      b.accountingValueNgn += valueNgn;
      b.coilCount += 1;
    };
    bump(byBranch, branchId, { branchId });
    bump(byMaterial, mat, { materialFamily: mat });
    bump(byGaugeColour, gc, { gaugeColour: gc });
  }

  const priceStats = computeMonthlyPurchasePriceStats(db, periodKey, branchScope);
  const replacementValueNgn = null;
  const replacementStatus = 'not_configured';

  const valuationDifferenceNgn =
    replacementValueNgn != null ? roundMoney(replacementValueNgn - accountingValueNgn) : null;

  return {
    ok: true,
    status: 'diagnostics_only',
    label: 'Inventory valuation report',
    disclaimer: 'Management diagnostic. Does not change inventory costs.',
    branchScope: branchScope === 'ALL' ? null : branchScope,
    period: period || { key: periodKey },
    generatedAtISO: new Date().toISOString(),
    valuationBasis: opts.valuationBasis || 'accounting_landed',
    accountingValueNgn,
    replacementValueNgn,
    replacementStatus,
    estimatedValueNgn,
    valuationDifferenceNgn,
    missingCostCount,
    monthlyAveragePurchasePriceNgn: priceStats.monthlyAverageNgn,
    highestPurchasePriceMonthNgn: priceStats.highestMonthNgn,
    highestPurchasePriceSample: priceStats.highestSample,
    byBranch: [...byBranch.values()],
    byMaterialFamily: [...byMaterial.values()],
    byGaugeColour: [...byGaugeColour.values()],
    missingCostSamples,
    notes,
  };
}

function computeMonthlyPurchasePriceStats(db, periodKey, branchScope) {
  if (!tableExists(db, 'purchase_order_lines') || !tableExists(db, 'purchase_orders')) {
    return { monthlyAverageNgn: null, highestMonthNgn: null, highestSample: null };
  }
  const [y, m] = String(periodKey).split('-').map(Number);
  const startISO = `${y}-${String(m).padStart(2, '0')}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const endISO = `${y}-${String(m).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

  const b = branchWhere(db, 'purchase_orders', branchScope);
  const rows = db
    .prepare(
      `SELECT l.unit_price_ngn, l.unit_price_per_kg_ngn, l.qty_ordered, p.po_id
       FROM purchase_order_lines l
       JOIN purchase_orders p ON p.po_id = l.po_id
       WHERE substr(COALESCE(p.order_date_iso,''),1,10) >= ? AND substr(COALESCE(p.order_date_iso,''),1,10) <= ?
       ${b.sql}`
    )
    .all(startISO, endISO, ...b.args);

  const prices = [];
  let highest = 0;
  let highestSample = null;
  for (const r of rows) {
    const up = roundMoney(r.unit_price_ngn) || roundMoney(r.unit_price_per_kg_ngn);
    if (up <= 0) continue;
    prices.push(up);
    if (up > highest) {
      highest = up;
      highestSample = { poId: r.po_id, unitPriceNgn: up };
    }
  }
  const monthlyAverageNgn = prices.length
    ? roundMoney(prices.reduce((s, p) => s + p, 0) / prices.length)
    : null;
  return { monthlyAverageNgn, highestMonthNgn: highest || null, highestSample };
}

function emptyInventoryReport(branchScope, period, notes) {
  return {
    ok: true,
    status: 'diagnostics_only',
    label: 'Inventory valuation report',
    accountingValueNgn: 0,
    replacementValueNgn: null,
    replacementStatus: 'not_configured',
    estimatedValueNgn: 0,
    missingCostCount: 0,
    byBranch: [],
    byMaterialFamily: [],
    byGaugeColour: [],
    notes,
    branchScope: branchScope === 'ALL' ? null : branchScope,
    period: period || null,
  };
}

export function buildInventoryValuationTrialSummary(db, branchScope = 'ALL') {
  const r = buildInventoryValuationReport(db, { branchId: branchScope === 'ALL' ? null : branchScope });
  if (r.status === 'disabled') return { available: false };
  return {
    available: true,
    accountingValueNgn: r.accountingValueNgn,
    missingCostCount: r.missingCostCount,
    replacementStatus: r.replacementStatus,
    monthlyAveragePurchasePriceNgn: r.monthlyAveragePurchasePriceNgn,
  };
}
