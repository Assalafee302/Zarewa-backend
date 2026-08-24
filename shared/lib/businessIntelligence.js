/**
 * Business intelligence — sales mix, aluminium/aluzinc inventory, and predictive cash signals.
 * Pure functions over workspace / ERP snapshots (shared by API and Zare).
 */
import { materialFamilyKeyForConversion } from './coilMaterialFamily.js';
import {
  allocatedQuotationRevenueForProductionJob,
  metersProducedByQuotationRef,
  productionAttributedRevenueNgn,
  productionOutputDateISO,
  receivablesAgingBuckets,
} from './liveAnalytics.js';
import { normalizeMaterialProfile } from './materialProfileNormalize.js';
import { receiptEffectiveCashNgn } from './receiptClearance.js';
import { poLineOpenQtyForReceiving } from './poLineTypes.js';

const ALU_PRODUCT_IDS = new Set(['COIL-ALU', 'MAT-001']);
const ALUZ_PRODUCT_IDS = new Set(['PRD-102', 'MAT-002']);
const COIL_FAMILIES = ['aluminium', 'aluzinc'];

/** Bump when BI engine logic changes — surfaced in /api/health and BI payloads for deploy checks. */
export const BI_ENGINE_REV = 'bi-v6';

/** @typedef {'month' | '4months' | 'half' | 'year'} BiPeriodKey */

export const BI_PERIOD_OPTIONS = [
  { key: 'month', label: 'This month', shortLabel: 'Month', monthsSpan: 1 },
  { key: '4months', label: 'Last 4 months', shortLabel: '4 mo', monthsSpan: 4 },
  { key: 'half', label: 'Last 6 months', shortLabel: 'Half yr', monthsSpan: 6 },
  { key: 'year', label: 'Last 12 months', shortLabel: 'Year', monthsSpan: 12 },
];

function toIsoDate(value) {
  return String(value || '').slice(0, 10);
}

function monthKey(iso) {
  const d = toIsoDate(iso);
  return d ? d.slice(0, 7) : '';
}

function periodStartISO(periodKey = 'month', baseDate = new Date()) {
  const opt = BI_PERIOD_OPTIONS.find((p) => p.key === periodKey) || BI_PERIOD_OPTIONS[0];
  const subtract = opt.monthsSpan - 1;
  const d = baseDate instanceof Date && !Number.isNaN(baseDate.getTime()) ? baseDate : new Date();
  let ty = d.getUTCFullYear();
  let tm = d.getUTCMonth() - subtract;
  while (tm < 0) {
    tm += 12;
    ty -= 1;
  }
  return `${ty}-${String(tm + 1).padStart(2, '0')}-01`;
}

/**
 * Resolve inclusive period bounds for analytics (explicit ISO range overrides periodKey).
 * @param {{ periodKey?: string; asOfISO?: string; periodStartISO?: string; periodEndISO?: string }} opts
 */
export function resolveBiPeriodBounds(opts = {}) {
  const endIso = toIsoDate(opts.periodEndISO || opts.asOfISO || new Date().toISOString());
  const startIso = opts.periodStartISO
    ? toIsoDate(opts.periodStartISO)
    : periodStartISO(opts.periodKey || 'month', new Date(`${endIso}T12:00:00`));
  return { startIso, endIso };
}

function addDaysISO(iso, days) {
  const d = new Date(`${toIsoDate(iso)}T12:00:00`);
  if (Number.isNaN(d.getTime())) return toIsoDate(new Date());
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(startIso, endIso) {
  const a = new Date(`${toIsoDate(startIso)}T00:00:00`);
  const b = new Date(`${toIsoDate(endIso)}T12:00:00`);
  if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 30;
  return Math.max(1, Math.round((b.getTime() - a.getTime()) / (24 * 60 * 60 * 1000)));
}

function materialSpecFromQuotation(q) {
  if (!q) return { colour: '—', gauge: '—', profile: '—' };
  const colour = String(q.materialColor ?? q.material_color ?? q.color ?? '').trim();
  const gauge = String(q.materialGauge ?? q.material_gauge ?? q.gauge ?? '').trim();
  const profileRaw = String(q.materialDesign ?? q.material_design ?? q.profile ?? '').trim();
  const profile = normalizeMaterialProfile(profileRaw);
  return {
    colour: colour || '—',
    gauge: gauge || '—',
    profile: profile || '—',
  };
}

function gaugeMmFromLabel(gaugeRaw) {
  const m = String(gaugeRaw || '').match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : 0;
}

function receiptCashNgn(receipt) {
  const cash = Number(receipt?.cashReceivedNgn);
  if (Number.isFinite(cash) && cash > 0) return Math.round(cash);
  return Math.round(Number(receipt?.amountNgn) || 0);
}

function refundImpactNgn(refund) {
  const status = String(refund?.status || '').toLowerCase();
  if (status === 'paid') return Math.round(Number(refund?.paidAmountNgn) || 0);
  if (status === 'approved') {
    return Math.round(Number(refund?.approvedAmountNgn) || Number(refund?.amountNgn) || 0);
  }
  return 0;
}

/**
 * Top customers by net cash collected (receipts minus approved/paid refunds) in the period.
 * @param {object[]} receipts
 * @param {object[]} refunds
 * @param {string} startIso
 * @param {string} endIso
 * @param {number} [limit]
 */
export function topCustomersByNetPayments(receipts = [], refunds = [], startIso, endIso, limit = 10) {
  /** @type {Map<string, { customerID: string; customerName: string; paymentsNgn: number; refundsNgn: number; receiptCount: number; refundCount: number }>} */
  const byCustomer = new Map();

  for (const r of receipts) {
    const d = toIsoDate(r.dateISO || r.date);
    if (!d || d < startIso || d > endIso) continue;
    const pay = receiptCashNgn(r);
    if (pay <= 0) continue;
    const cid = String(r.customerID || r.customer || '').trim();
    if (!cid) continue;
    const curr = byCustomer.get(cid) || {
      customerID: cid,
      customerName: r.customer || cid,
      paymentsNgn: 0,
      refundsNgn: 0,
      receiptCount: 0,
      refundCount: 0,
    };
    curr.paymentsNgn += pay;
    curr.receiptCount += 1;
    byCustomer.set(cid, curr);
  }

  for (const rf of refunds) {
    const d = toIsoDate(rf.requestedAtISO || rf.paidAtISO);
    if (!d || d < startIso || d > endIso) continue;
    const amt = refundImpactNgn(rf);
    if (amt <= 0) continue;
    const cid = String(rf.customerID || rf.customer || '').trim();
    if (!cid) continue;
    const curr = byCustomer.get(cid) || {
      customerID: cid,
      customerName: rf.customer || cid,
      paymentsNgn: 0,
      refundsNgn: 0,
      receiptCount: 0,
      refundCount: 0,
    };
    curr.refundsNgn += amt;
    curr.refundCount += 1;
    byCustomer.set(cid, curr);
  }

  return [...byCustomer.values()]
    .map((row) => ({
      ...row,
      paymentsNgn: Math.round(row.paymentsNgn),
      refundsNgn: Math.round(row.refundsNgn),
      netCollectedNgn: Math.round(row.paymentsNgn - row.refundsNgn),
    }))
    .filter((row) => row.netCollectedNgn > 0 || row.paymentsNgn > 0)
    .sort((a, b) => b.netCollectedNgn - a.netCollectedNgn || b.paymentsNgn - a.paymentsNgn)
    .slice(0, limit);
}

function productionJobIsCompleted(job) {
  return String(job?.status || '').trim() === 'Completed';
}

function liveCoilKg(lot) {
  if (lot?.currentWeightKg != null && lot.currentWeightKg !== '') {
    const cw = Number(lot.currentWeightKg);
    if (Number.isFinite(cw)) return Math.max(0, cw);
  }
  if (lot?.qtyRemaining != null && lot.qtyRemaining !== '') {
    const qr = Number(lot.qtyRemaining);
    if (Number.isFinite(qr)) return Math.max(0, qr);
  }
  const w = Number(lot?.weightKg);
  if (Number.isFinite(w) && w > 0) return w;
  const q = Number(lot?.qtyReceived);
  return Number.isFinite(q) ? Math.max(0, q) : 0;
}

/**
 * @param {{ productID?: string; materialTypeId?: string; materialTypeName?: string; materialType?: string; productName?: string; materialDesign?: string }} ctx
 * @returns {'aluminium' | 'aluzinc' | 'stone' | 'other'}
 */
export function resolveBusinessMaterialFamily(ctx = {}) {
  const pid = String(ctx.productID || ctx.productId || '').trim().toUpperCase();
  if (ALU_PRODUCT_IDS.has(pid)) return 'aluminium';
  if (ALUZ_PRODUCT_IDS.has(pid)) return 'aluzinc';

  const mtId = String(ctx.materialTypeId || '').trim();
  if (mtId === 'MAT-001') return 'aluminium';
  if (mtId === 'MAT-002') return 'aluzinc';

  const labels = [
    ctx.materialTypeName,
    ctx.materialType,
    ctx.productName,
    ctx.materialDesign,
  ]
    .filter(Boolean)
    .join(' ');
  const key = materialFamilyKeyForConversion(labels);
  if (key === 'aluminium' || key === 'aluzinc' || key === 'stone') return key;
  return 'other';
}

function coilFamilyFromLot(lot) {
  const fam = materialFamilyKeyForConversion(lot?.materialTypeName || lot?.material_type_name);
  if (fam === 'aluminium' || fam === 'aluzinc') return fam;
  return resolveBusinessMaterialFamily({ productID: lot?.productID || lot?.product_id });
}

function skuKgForFamily(products, family) {
  const pid = family === 'aluminium' ? 'COIL-ALU' : 'PRD-102';
  const row = (products || []).find((p) => String(p.productID || '').trim() === pid);
  return Math.max(0, Number(row?.stockLevel) || 0);
}

function familyProductId(family) {
  return family === 'aluminium' ? 'COIL-ALU' : 'PRD-102';
}

function consumptionKgInRange(stockMovements, family, startIso, endIso) {
  const pid = familyProductId(family);
  let kg = 0;
  for (const m of stockMovements || []) {
    const type = String(m?.type || '');
    if (!type.includes('CONSUMPTION') && type !== 'COIL_CONSUMPTION') continue;
    const mpid = String(m?.productID || m?.product_id || '').trim();
    if (mpid && mpid !== pid) continue;
    const iso = toIsoDate(m.atISO || m.dateISO);
    if (!iso || iso < startIso || iso > endIso) continue;
    kg += Math.abs(Number(m.qty) || 0);
  }
  return kg;
}

function productionKgInRange(productionJobs, quotations, family, startIso, endIso) {
  const quoteById = new Map((quotations || []).map((q) => [q.id, q]));
  let kg = 0;
  for (const j of productionJobs || []) {
    if (!productionJobIsCompleted(j)) continue;
    const d = productionOutputDateISO(j);
    if (!d || d < startIso || d > endIso) continue;
    const q = quoteById.get(String(j.quotationRef || '').trim());
    const fam = resolveBusinessMaterialFamily({
      productID: j.productID,
      productName: j.productName,
      materialTypeId: q?.materialTypeId,
      materialDesign: q?.materialDesign,
    });
    if (fam !== family) continue;
    const w = Number(j.actualWeightKg) || 0;
    if (w > 0) kg += w;
  }
  return kg;
}

function incomingPoKg(purchaseOrders, family) {
  const pid = familyProductId(family);
  let kg = 0;
  for (const po of purchaseOrders || []) {
    const st = String(po?.status || '').toLowerCase();
    if (['cancelled', 'canceled', 'closed', 'received'].includes(st)) continue;
    for (const line of po.lines || []) {
      if (String(line?.productID || '').trim() !== pid) continue;
      const ordered = Number(line.qtyOrdered) || 0;
      const received = Number(line.qtyReceived) || 0;
      kg += Math.max(0, ordered - received);
    }
  }
  return Math.round(kg);
}

function coilInventoryForFamily(coilLots, family) {
  const active = (coilLots || []).filter((c) => c.currentStatus !== 'Consumed');
  let kgOnHand = 0;
  let valuationNgn = 0;
  let lowCoilCount = 0;
  /** @type {Map<string, { gauge: string; colour: string; kg: number; coilCount: number }>} */
  const buckets = new Map();

  for (const lot of active) {
    const fam = coilFamilyFromLot(lot);
    if (fam !== family) continue;
    const kg = liveCoilKg(lot);
    kgOnHand += kg;
    if (kg > 0 && kg < 100) lowCoilCount += 1;
    const unit = Number(lot.unitCostNgnPerKg) || 0;
    if (unit > 0 && kg > 0) valuationNgn += Math.round(kg * unit);
    else if (Number(lot.landedCostNgn) > 0) valuationNgn += Math.round(Number(lot.landedCostNgn));

    const gauge = lot.gaugeLabel || lot.gauge || '—';
    const colour = lot.colour || lot.color || '—';
    const key = `${gauge}|${colour}`;
    const prev = buckets.get(key) || { gauge, colour, kg: 0, coilCount: 0 };
    prev.kg += kg;
    prev.coilCount += 1;
    buckets.set(key, prev);
  }

  const topGaugeColour = [...buckets.values()].sort((a, b) => b.kg - a.kg).slice(0, 6);

  return {
    family,
    label: family === 'aluminium' ? 'Aluminium' : 'Aluzinc (PPGI)',
    productID: familyProductId(family),
    kgOnHand: Math.round(kgOnHand),
    skuKgLedger: skuKgForFamily([], family),
    valuationNgn: Math.round(valuationNgn),
    lowCoilCount,
    topGaugeColour,
  };
}

/**
 * Weighted average coil cost ₦/kg by family + gauge + colour (from live lots).
 * @param {object[]} coilLots
 */
export function buildCoilUnitCostIndex(coilLots = []) {
  /** @type {Map<string, { kg: number; costNgn: number }>} */
  const byKey = new Map();
  /** @type {Record<string, { kg: number; costNgn: number }>} */
  const familyTotals = { aluminium: { kg: 0, costNgn: 0 }, aluzinc: { kg: 0, costNgn: 0 } };

  for (const lot of coilLots) {
    if (lot?.currentStatus === 'Consumed') continue;
    const fam = coilFamilyFromLot(lot);
    if (fam !== 'aluminium' && fam !== 'aluzinc') continue;
    const kg = liveCoilKg(lot);
    if (kg <= 0) continue;
    const gauge = lot.gaugeLabel || lot.gauge || '—';
    const colour = lot.colour || lot.color || '—';
    const unit = Number(lot.unitCostNgnPerKg) || 0;
    const cost =
      unit > 0 ? kg * unit : Math.max(0, Number(lot.landedCostNgn) || 0);
    const unitPerKg = cost > 0 && kg > 0 ? cost / kg : 0;
    if (unitPerKg <= 0) continue;

    const key = `${fam}|${gauge}|${colour}`;
    const prev = byKey.get(key) || { kg: 0, costNgn: 0 };
    prev.kg += kg;
    prev.costNgn += Math.round(cost);
    byKey.set(key, prev);

    familyTotals[fam].kg += kg;
    familyTotals[fam].costNgn += Math.round(cost);
  }

  const index = new Map();
  for (const [key, v] of byKey) {
    index.set(key, v.kg > 0 ? v.costNgn / v.kg : 0);
  }
  const familyAvg = {
    aluminium: familyTotals.aluminium.kg > 0 ? familyTotals.aluminium.costNgn / familyTotals.aluminium.kg : 0,
    aluzinc: familyTotals.aluzinc.kg > 0 ? familyTotals.aluzinc.costNgn / familyTotals.aluzinc.kg : 0,
  };
  return { bySku: index, familyAvg };
}

function resolveEntityBranchId(entity, quoteById) {
  const direct = String(entity?.branchId || entity?.branch_id || '').trim();
  if (direct) return direct;
  const ref = String(entity?.quotationRef || '').trim();
  if (ref && quoteById) {
    const q = quoteById.get(ref);
    const qb = String(q?.branchId || q?.branch_id || '').trim();
    if (qb) return qb;
  }
  return 'UNASSIGNED';
}

/**
 * Branch scorecards when scope is ALL — produced sales, collections, coil stock, top SKU signals.
 * @param {object} data
 * @param {{ periodKey?: BiPeriodKey; asOfISO?: string; branchScope?: string }} opts
 */
export function computeBranchBreakdown(data, opts = {}) {
  const scope = String(opts.branchScope || 'ALL').trim();
  if (scope && scope !== 'ALL') {
    return { scopeSingle: scope, byBranch: [] };
  }

  const { startIso, endIso: asOfISO } = resolveBiPeriodBounds(opts);
  const quoteById = new Map((data.quotations || []).map((q) => [String(q.id || '').trim(), q]));
  const metersByRef = metersProducedByQuotationRef(data.productionJobs || []);

  /** @type {Map<string, { branchId: string; producedRevenueNgn: number; paymentsNgn: number; refundsNgn: number; coilKgOnHand: number; coilValuationNgn: number }>} */
  const byBranch = new Map();

  const ensure = (branchId) => {
    const id = branchId || 'UNASSIGNED';
    if (!byBranch.has(id)) {
      byBranch.set(id, {
        branchId: id,
        producedRevenueNgn: 0,
        paymentsNgn: 0,
        refundsNgn: 0,
        coilKgOnHand: 0,
        coilValuationNgn: 0,
      });
    }
    return byBranch.get(id);
  };

  for (const j of data.productionJobs || []) {
    if (!productionJobIsCompleted(j)) continue;
    const d = productionOutputDateISO(j);
    if (!d || d < startIso || d > asOfISO) continue;
    const q = quoteById.get(String(j.quotationRef || '').trim());
    const row = ensure(resolveEntityBranchId(j, quoteById));
    row.producedRevenueNgn += allocatedQuotationRevenueForProductionJob(j, q, metersByRef);
  }

  for (const r of data.receipts || []) {
    const d = toIsoDate(r.dateISO || r.date);
    if (!d || d < startIso || d > asOfISO) continue;
    const row = ensure(resolveEntityBranchId(r, quoteById));
    row.paymentsNgn += receiptCashNgn(r);
  }

  for (const rf of data.refunds || []) {
    const d = toIsoDate(rf.requestedAtISO || rf.paidAtISO);
    if (!d || d < startIso || d > asOfISO) continue;
    const amt = refundImpactNgn(rf);
    if (amt <= 0) continue;
    const row = ensure(resolveEntityBranchId(rf, quoteById));
    row.refundsNgn += amt;
  }

  for (const lot of (data.coilLots || []).filter((c) => c.currentStatus !== 'Consumed')) {
    const fam = coilFamilyFromLot(lot);
    if (fam !== 'aluminium' && fam !== 'aluzinc') continue;
    const row = ensure(String(lot.branchId || '').trim() || 'UNASSIGNED');
    const kg = liveCoilKg(lot);
    row.coilKgOnHand += kg;
    const unit = Number(lot.unitCostNgnPerKg) || 0;
    row.coilValuationNgn +=
      unit > 0 && kg > 0 ? Math.round(kg * unit) : Math.round(Number(lot.landedCostNgn) || 0);
  }

  const branchSkuTables = [];
  for (const row of byBranch.values()) {
    const filtered = filterBiDataByBranch(data, row.branchId);
    const mat = computeMaterialPerformance(filtered, opts);
    const sku = computeSkuIntelligence(filtered, mat, opts);
    const topCombo = mat.aluminium?.topCombinations?.[0] || mat.aluzinc?.topCombinations?.[0];
    branchSkuTables.push({
      branchId: row.branchId,
      topMaterialLabel: topCombo
        ? `${topCombo.gauge} · ${topCombo.colour} · ${topCombo.profile}`
        : '—',
      buySkuCount:
        (sku.aluminium?.buyNext?.length || 0) + (sku.aluzinc?.buyNext?.length || 0),
      liquidateSkuCount:
        (sku.aluminium?.reduceStock?.length || 0) + (sku.aluzinc?.reduceStock?.length || 0),
      topBuy:
        sku.aluminium?.buyNext?.[0] || sku.aluzinc?.buyNext?.[0] || null,
      topLiquidate:
        sku.aluminium?.reduceStock?.[0] || sku.aluzinc?.reduceStock?.[0] || null,
    });
  }

  const skuByBranch = new Map(branchSkuTables.map((t) => [t.branchId, t]));

  const byBranchRows = [...byBranch.values()]
    .map((r) => {
      const sku = skuByBranch.get(r.branchId) || {};
      return {
        ...r,
        producedRevenueNgn: Math.round(r.producedRevenueNgn),
        paymentsNgn: Math.round(r.paymentsNgn),
        refundsNgn: Math.round(r.refundsNgn),
        netCollectedNgn: Math.round(r.paymentsNgn - r.refundsNgn),
        coilKgOnHand: Math.round(r.coilKgOnHand),
        coilValuationNgn: Math.round(r.coilValuationNgn),
        topMaterialLabel: sku.topMaterialLabel || '—',
        buySkuCount: sku.buySkuCount || 0,
        liquidateSkuCount: sku.liquidateSkuCount || 0,
        topBuy: sku.topBuy || null,
        topLiquidate: sku.topLiquidate || null,
      };
    })
    .sort((a, b) => b.producedRevenueNgn - a.producedRevenueNgn);

  return {
    periodStartISO: startIso,
    periodEndISO: asOfISO,
    byBranch: byBranchRows,
  };
}

/**
 * @param {object} data
 * @param {string} branchId
 */
export function filterBiDataByBranch(data, branchId) {
  const id = String(branchId || '').trim();
  const quoteById = new Map((data.quotations || []).map((q) => [String(q.id || '').trim(), q]));
  const quoteMatches = (q) => resolveEntityBranchId(q, quoteById) === id;
  const entityMatches = (e) => resolveEntityBranchId(e, quoteById) === id;

  return {
    ...data,
    quotations: (data.quotations || []).filter(quoteMatches),
    productionJobs: (data.productionJobs || []).filter(entityMatches),
    receipts: (data.receipts || []).filter(entityMatches),
    refunds: (data.refunds || []).filter(entityMatches),
    coilLots: (data.coilLots || []).filter((lot) => String(lot.branchId || '').trim() === id),
    purchaseOrders: (data.purchaseOrders || []).filter(
      (po) => String(po.branchId || '').trim() === id
    ),
    stockMovements: data.stockMovements || [],
    products: data.products || [],
    cuttingLists: (data.cuttingLists || []).filter(entityMatches),
    ledgerEntries: data.ledgerEntries || [],
    expenses: data.expenses || [],
    treasuryMovements: data.treasuryMovements || [],
    paymentRequests: data.paymentRequests || [],
    treasuryAccounts: data.treasuryAccounts || [],
  };
}

/**
 * Material performance by gauge × colour × profile (produced sales basis), split by metal family.
 * @param {object} data
 * @param {{ periodKey?: BiPeriodKey; asOfISO?: string }} opts
 */
export function computeMaterialPerformance(data, opts = {}) {
  const asOfISO = toIsoDate(opts.asOfISO || new Date().toISOString());
  const startIso = periodStartISO(opts.periodKey || 'month', new Date(`${asOfISO}T12:00:00`));
  const quotations = data.quotations || [];
  const productionJobs = data.productionJobs || [];
  const quoteById = new Map(quotations.map((q) => [String(q.id || '').trim(), q]));
  const metersByRef = metersProducedByQuotationRef(productionJobs);
  const costIndex = buildCoilUnitCostIndex(data.coilLots || []);

  /** @type {Record<string, { combo: Map<string, object>; gauge: Map<string, object>; colour: Map<string, object> }>} */
  const byFamily = {
    aluminium: { combo: new Map(), gauge: new Map(), colour: new Map() },
    aluzinc: { combo: new Map(), gauge: new Map(), colour: new Map() },
  };

  const unitCostFor = (fam, gauge, colour, _weightKg) => {
    const skuKey = `${fam}|${gauge}|${colour}`;
    const sku = costIndex.bySku.get(skuKey);
    if (sku > 0) return sku;
    return costIndex.familyAvg[fam] || 0;
  };

  const bump = (map, key, label, metres, revenueNgn, weightKg, cogsNgn) => {
    const prev =
      map.get(key) || { key: label, metres: 0, revenueNgn: 0, weightKg: 0, cogsNgn: 0, jobCount: 0 };
    prev.metres += metres;
    prev.revenueNgn += revenueNgn;
    prev.weightKg += weightKg;
    prev.cogsNgn += cogsNgn;
    prev.jobCount += 1;
    map.set(key, prev);
  };

  for (const j of productionJobs) {
    if (!productionJobIsCompleted(j)) continue;
    const d = productionOutputDateISO(j);
    if (!d || d < startIso || d > asOfISO) continue;
    const metres = Number(j.actualMeters) || 0;
    if (metres <= 0) continue;
    const q = quoteById.get(String(j.quotationRef || '').trim());
    const fam = resolveBusinessMaterialFamily({
      productID: j.productID,
      productName: j.productName,
      materialTypeId: q?.materialTypeId,
      materialDesign: q?.materialDesign,
    });
    if (fam !== 'aluminium' && fam !== 'aluzinc') continue;
    const spec = materialSpecFromQuotation(q);
    const revenueNgn = allocatedQuotationRevenueForProductionJob(j, q, metersByRef);
    const weightKg =
      Number(j.actualWeightKg) > 0
        ? Number(j.actualWeightKg)
        : Math.round(metres * (gaugeMmFromLabel(spec.gauge) <= 0.26 ? 2.65 : 2.9));

    const unitCost = unitCostFor(fam, spec.gauge, spec.colour, weightKg);
    const cogsNgn = unitCost > 0 && weightKg > 0 ? Math.round(weightKg * unitCost) : 0;

    const comboKey = `${spec.gauge}|${spec.colour}|${spec.profile}`;
    const buckets = byFamily[fam];
    bump(buckets.combo, comboKey, comboKey, metres, revenueNgn, weightKg, cogsNgn);
    bump(buckets.gauge, spec.gauge, spec.gauge, metres, revenueNgn, weightKg, cogsNgn);
    bump(buckets.colour, spec.colour, spec.colour, metres, revenueNgn, weightKg, cogsNgn);
  }

  const finalize = (map, limit = 6, withMargin = false) => {
    const rows = [...map.values()].map((r) => {
      const revenueNgn = Math.round(r.revenueNgn);
      const cogsNgn = Math.round(r.cogsNgn || 0);
      const marginNgn = revenueNgn - cogsNgn;
      const base = {
        label: r.key,
        metres: Math.round(r.metres),
        weightKg: Math.round(r.weightKg),
        revenueNgn,
        jobCount: r.jobCount,
      };
      if (!withMargin) return base;
      return {
        ...base,
        cogsNgn,
        marginNgn,
        marginPct: revenueNgn > 0 ? Math.round((marginNgn / revenueNgn) * 1000) / 10 : null,
      };
    });
    const totalMetres = rows.reduce((s, r) => s + r.metres, 0);
    return rows
      .map((row) => ({
        ...row,
        sharePctMetres: totalMetres > 0 ? Math.round((row.metres / totalMetres) * 1000) / 10 : 0,
      }))
      .sort((a, b) => b.metres - a.metres || b.revenueNgn - a.revenueNgn)
      .slice(0, limit);
  };

  const packFamily = (fam) => {
    const b = byFamily[fam];
    const topCombinations = finalize(b.combo, 8, true).map((row) => {
      const [gauge, colour, profile] = String(row.label).split('|');
      return { gauge, colour, profile, ...row };
    });
    return {
      family: fam,
      label: fam === 'aluminium' ? 'Aluminium' : 'Aluzinc (PPGI)',
      topCombinations,
      topGauges: finalize(b.gauge, 5),
      topColours: finalize(b.colour, 5),
    };
  };

  return {
    periodStartISO: startIso,
    periodEndISO: asOfISO,
    aluminium: packFamily('aluminium'),
    aluzinc: packFamily('aluzinc'),
  };
}

function poLineOpenValueNgn(line) {
  const openQty = poLineOpenQtyForReceiving(line);
  const unit = Number(line.unitPricePerKgNgn || line.unitPriceNgn) || 0;
  return openQty * unit;
}

/**
 * Coil SKU intelligence: gauge × colour combinations — reorder, watch, or liquidate (cash tied up).
 * @param {object} data
 * @param {ReturnType<typeof computeMaterialPerformance>} materialPerformance
 * @param {{ periodKey?: BiPeriodKey; asOfISO?: string }} opts
 */
export function computeSkuIntelligence(data, materialPerformance, opts = {}) {
  const asOfISO = toIsoDate(opts.asOfISO || new Date().toISOString());
  const startIso = periodStartISO(opts.periodKey || 'month', new Date(`${asOfISO}T12:00:00`));
  const windowDays = daysBetween(startIso, asOfISO);
  const quotations = data.quotations || [];
  const productionJobs = data.productionJobs || [];
  const quoteById = new Map(quotations.map((q) => [String(q.id || '').trim(), q]));

  /** @type {Record<string, Map<string, { gauge: string; colour: string; kgOnHand: number; valuationNgn: number; coilCount: number }>>} */
  const stockByFamily = { aluminium: new Map(), aluzinc: new Map() };
  /** @type {Record<string, Map<string, number>>} */
  const demandKgByFamily = { aluminium: new Map(), aluzinc: new Map() };

  for (const lot of (data.coilLots || []).filter((c) => c.currentStatus !== 'Consumed')) {
    const fam = coilFamilyFromLot(lot);
    if (fam !== 'aluminium' && fam !== 'aluzinc') continue;
    const gauge = lot.gaugeLabel || lot.gauge || '—';
    const colour = lot.colour || lot.color || '—';
    const key = `${gauge}|${colour}`;
    const kg = liveCoilKg(lot);
    const unit = Number(lot.unitCostNgnPerKg) || 0;
    const val =
      unit > 0 && kg > 0
        ? Math.round(kg * unit)
        : Math.round(Number(lot.landedCostNgn) || 0);
    const prev = stockByFamily[fam].get(key) || {
      gauge,
      colour,
      kgOnHand: 0,
      valuationNgn: 0,
      coilCount: 0,
    };
    prev.kgOnHand += kg;
    prev.valuationNgn += val;
    prev.coilCount += 1;
    stockByFamily[fam].set(key, prev);
  }

  for (const j of productionJobs) {
    if (!productionJobIsCompleted(j)) continue;
    const d = productionOutputDateISO(j);
    if (!d || d < startIso || d > asOfISO) continue;
    const q = quoteById.get(String(j.quotationRef || '').trim());
    const fam = resolveBusinessMaterialFamily({
      productID: j.productID,
      materialTypeId: q?.materialTypeId,
      materialDesign: q?.materialDesign,
    });
    if (fam !== 'aluminium' && fam !== 'aluzinc') continue;
    const spec = materialSpecFromQuotation(q);
    const key = `${spec.gauge}|${spec.colour}`;
    const w = Number(j.actualWeightKg) || 0;
    demandKgByFamily[fam].set(key, (demandKgByFamily[fam].get(key) || 0) + (w > 0 ? w : 0));
  }

  const topDemandKeys = (fam) => {
    const perf = fam === 'aluminium' ? materialPerformance?.aluminium : materialPerformance?.aluzinc;
    return new Set(
      (perf?.topCombinations || []).slice(0, 5).map((c) => `${c.gauge}|${c.colour}`)
    );
  };

  const analyzeFamily = (fam) => {
    const demandKeys = topDemandKeys(fam);
    /** @type {object[]} */
    const rows = [];
    const keys = new Set([...stockByFamily[fam].keys(), ...demandKgByFamily[fam].keys()]);
    for (const key of keys) {
      const stock = stockByFamily[fam].get(key) || {
        gauge: key.split('|')[0],
        colour: key.split('|')[1],
        kgOnHand: 0,
        valuationNgn: 0,
        coilCount: 0,
      };
      const kgDemand = demandKgByFamily[fam].get(key) || 0;
      const dailyDemand = kgDemand / windowDays;
      const weeksCover =
        dailyDemand > 0 ? Math.round((stock.kgOnHand / dailyDemand / 7) * 10) / 10 : null;
      const monthsOfStock =
        kgDemand > 0 ? Math.round((stock.kgOnHand / kgDemand) * 10) / 10 : null;

      let action = 'ok';
      let reason = 'Balanced stock vs recent production pull.';
      if (stock.kgOnHand > 0 && (weeksCover == null || weeksCover > 16) && kgDemand < stock.kgOnHand * 0.15) {
        action = 'liquidate';
        reason = 'High kg on hand with very low consumption — cash tied up in slow movers.';
      } else if (weeksCover != null && weeksCover < 2) {
        action = 'buy';
        reason = 'Under 2 weeks cover at current consumption.';
      } else if (demandKeys.has(key) && (weeksCover == null || weeksCover < 6)) {
        action = 'buy';
        reason = 'Top-selling gauge/colour combination needs replenishment.';
      } else if (weeksCover != null && weeksCover < 4) {
        action = 'watch';
        reason = 'Cover tightening — review procurement before stockout.';
      } else if (stock.kgOnHand > 800 && monthsOfStock != null && monthsOfStock > 3) {
        action = 'watch';
        reason = 'Elevated stock relative to period demand.';
      }

      rows.push({
        family: fam,
        gauge: stock.gauge,
        colour: stock.colour,
        kgOnHand: Math.round(stock.kgOnHand),
        valuationNgn: Math.round(stock.valuationNgn),
        kgDemandPeriod: Math.round(kgDemand),
        weeksCover,
        action,
        reason,
      });
    }

    const buyNext = rows
      .filter((r) => r.action === 'buy')
      .sort((a, b) => (a.weeksCover ?? 0) - (b.weeksCover ?? 0))
      .slice(0, 6);
    const reduceStock = rows
      .filter((r) => r.action === 'liquidate')
      .sort((a, b) => b.valuationNgn - a.valuationNgn)
      .slice(0, 6);
    const needsAttention = rows
      .filter((r) => r.action === 'watch' || r.action === 'buy')
      .sort((a, b) => {
        const rank = { buy: 0, watch: 1, ok: 2, liquidate: 3 };
        return (rank[a.action] || 9) - (rank[b.action] || 9);
      })
      .slice(0, 8);

    return { buyNext, reduceStock, needsAttention };
  };

  return {
    asOfISO,
    periodStartISO: startIso,
    aluminium: analyzeFamily('aluminium'),
    aluzinc: analyzeFamily('aluzinc'),
  };
}

/**
 * Supplier focus from purchase orders (spend, open commitment, coil lines).
 * @param {object} data
 * @param {{ periodKey?: BiPeriodKey; asOfISO?: string }} opts
 */
export function computeProcurementInsights(data, opts = {}) {
  const asOfISO = toIsoDate(opts.asOfISO || new Date().toISOString());
  const lookbackStart = periodStartISO('4months', new Date(`${asOfISO}T12:00:00`));
  const pos = data.purchaseOrders || [];

  /** @type {Map<string, { supplierID: string; supplierName: string; spendNgn: number; openNgn: number; poCount: number; coilKgOrdered: number }>} */
  const bySupplier = new Map();

  for (const po of pos) {
    const orderDate = toIsoDate(po.orderDateISO);
    const st = String(po.status || '').toLowerCase();
    if (['cancelled', 'canceled', 'rejected'].includes(st)) continue;
    const sid = String(po.supplierID || po.supplierName || '').trim();
    if (!sid) continue;
    const name = String(po.supplierName || sid).trim();
    const curr = bySupplier.get(sid) || {
      supplierID: sid,
      supplierName: name,
      spendNgn: 0,
      openNgn: 0,
      poCount: 0,
      coilKgOrdered: 0,
    };

    let poTotal = 0;
    let open = 0;
    for (const line of po.lines || []) {
      const ordered = Number(line.qtyOrdered) || 0;
      const received = Number(line.qtyReceived) || 0;
      const unit = Number(line.unitPricePerKgNgn || line.unitPriceNgn) || 0;
      poTotal += ordered * unit;
      open += poLineOpenValueNgn(line);
      const pid = String(line.productID || '').trim();
      if (pid === 'COIL-ALU' || pid === 'PRD-102') {
        curr.coilKgOrdered += Math.max(0, ordered - received);
      }
    }

    if (orderDate && orderDate >= lookbackStart && orderDate <= asOfISO) {
      curr.spendNgn += Math.round(poTotal);
      curr.poCount += 1;
    }
    if (!['closed', 'received', 'cancelled', 'canceled'].includes(st)) {
      curr.openNgn += Math.round(open);
    }
    bySupplier.set(sid, curr);
  }

  const supplierFocus = [...bySupplier.values()]
    .map((r) => ({
      ...r,
      spendNgn: Math.round(r.spendNgn),
      openNgn: Math.round(r.openNgn),
      coilKgOrdered: Math.round(r.coilKgOrdered),
      priorityScore: Math.round(r.openNgn + r.spendNgn * 0.2 + r.coilKgOrdered * 500),
    }))
    .filter((r) => r.spendNgn > 0 || r.openNgn > 0)
    .sort((a, b) => b.priorityScore - a.priorityScore)
    .slice(0, 8);

  return {
    asOfISO,
    lookbackStartISO: lookbackStart,
    supplierFocus,
  };
}

/**
 * @param {object} data
 * @param {{ periodKey?: BiPeriodKey; asOfISO?: string }} opts
 */
export function computeInventoryAnalytics(data, opts = {}) {
  const asOfISO = toIsoDate(opts.asOfISO || new Date().toISOString());
  const startIso = periodStartISO(opts.periodKey || 'month', new Date(`${asOfISO}T12:00:00`));
  const windowDays = daysBetween(startIso, asOfISO);

  const families = COIL_FAMILIES.map((family) => {
    const base = coilInventoryForFamily(data.coilLots, family);
    base.skuKgLedger = skuKgForFamily(data.products, family);
    const consumedMovement = consumptionKgInRange(data.stockMovements, family, startIso, asOfISO);
    const consumedProduction = productionKgInRange(
      data.productionJobs,
      data.quotations,
      family,
      startIso,
      asOfISO
    );
    const kgConsumed = Math.max(consumedMovement, consumedProduction);
    const dailyRate = kgConsumed / windowDays;
    const weeksCover = dailyRate > 0 ? Math.round((base.kgOnHand / dailyRate / 7) * 10) / 10 : null;
    const incomingKg = incomingPoKg(data.purchaseOrders, family);
    const stockoutDays =
      dailyRate > 0 ? Math.round((base.kgOnHand / dailyRate) * 10) / 10 : null;

    let risk = 'ok';
    if (weeksCover != null && weeksCover < 2) risk = 'critical';
    else if (weeksCover != null && weeksCover < 4) risk = 'watch';

    return {
      ...base,
      kgConsumedPeriod: Math.round(kgConsumed),
      dailyConsumptionKg: Math.round(dailyRate * 10) / 10,
      weeksCover,
      stockoutDays,
      incomingKg,
      risk,
      periodStartISO: startIso,
      periodEndISO: asOfISO,
    };
  });

  const totalKg = families.reduce((s, f) => s + f.kgOnHand, 0);
  const materialPerformance = computeMaterialPerformance(data, opts);
  const skuIntelligence = computeSkuIntelligence(data, materialPerformance, opts);

  return {
    asOfISO,
    periodKey: opts.periodKey || 'month',
    families,
    totalCoilKg: totalKg,
    aluminiumSharePct:
      totalKg > 0 ? Math.round((families[0].kgOnHand / totalKg) * 1000) / 10 : 0,
    aluzincSharePct:
      totalKg > 0 ? Math.round((families[1].kgOnHand / totalKg) * 1000) / 10 : 0,
    skuIntelligence,
  };
}

/**
 * @param {object} data
 * @param {{ periodKey?: BiPeriodKey; asOfISO?: string }} opts
 */
export function computeSalesAnalytics(data, opts = {}) {
  const { startIso, endIso: asOfISO } = resolveBiPeriodBounds(opts);
  const quotations = data.quotations || [];
  const productionJobs = data.productionJobs || [];
  const cuttingLists = data.cuttingLists || [];
  const receipts = data.receipts || [];
  const ledgerEntries = data.ledgerEntries || [];

  const quoteById = new Map(quotations.map((q) => [q.id, q]));
  const metersByRef = metersProducedByQuotationRef(productionJobs);

  const producedRevenueNgn = productionAttributedRevenueNgn(quotations, productionJobs, startIso, asOfISO);

  /** @type {Record<string, { family: string; revenueNgn: number; metres: number; jobCount: number }>} */
  const mix = {
    aluminium: { family: 'aluminium', revenueNgn: 0, metres: 0, jobCount: 0 },
    aluzinc: { family: 'aluzinc', revenueNgn: 0, metres: 0, jobCount: 0 },
    other: { family: 'other', revenueNgn: 0, metres: 0, jobCount: 0 },
  };

  for (const j of productionJobs) {
    if (!productionJobIsCompleted(j)) continue;
    const d = productionOutputDateISO(j);
    if (!d || d < startIso || d > asOfISO) continue;
    const m = Number(j.actualMeters) || 0;
    if (m <= 0) continue;
    const q = quoteById.get(String(j.quotationRef || '').trim());
    const fam = resolveBusinessMaterialFamily({
      productID: j.productID,
      productName: j.productName,
      materialTypeId: q?.materialTypeId,
      materialDesign: q?.materialDesign,
    });
    const bucket = mix[fam] || mix.other;
    bucket.metres += m;
    bucket.revenueNgn += allocatedQuotationRevenueForProductionJob(j, q, metersByRef);
    bucket.jobCount += 1;
  }

  const totalMetres = Object.values(mix).reduce((s, row) => s + row.metres, 0);
  const mixRows = Object.values(mix).map((row) => ({
    ...row,
    metres: Math.round(row.metres),
    revenueNgn: Math.round(row.revenueNgn),
    sharePct: producedRevenueNgn > 0 ? Math.round((row.revenueNgn / producedRevenueNgn) * 1000) / 10 : 0,
    sharePctMetres: totalMetres > 0 ? Math.round((row.metres / totalMetres) * 1000) / 10 : 0,
  }));

  const qInPeriod = quotations.filter((q) => {
    const d = toIsoDate(q.dateISO);
    return d && d >= startIso && d <= asOfISO;
  });

  const receiptsInPeriod = receipts.filter((r) => {
    const d = toIsoDate(r.dateISO || r.date);
    return d && d >= startIso && d <= asOfISO;
  });

  const collectedNgn = receiptsInPeriod.reduce((s, r) => s + receiptEffectiveCashNgn(r), 0);
  const quotedNgn = qInPeriod.reduce((s, q) => s + (Number(q.totalNgn) || 0), 0);

  const funnel = {
    quotations: qInPeriod.length,
    approved: qInPeriod.filter((q) => /approved|paid|partial|delivered/i.test(String(q.status || ''))).length,
    withPayment: qInPeriod.filter((q) => (Number(q.paidNgn) || 0) > 0).length,
    cuttingLists: cuttingLists.filter((cl) => {
      const d = toIsoDate(cl.dateISO);
      return d && d >= startIso && d <= asOfISO;
    }).length,
    productionCompleted: productionJobs.filter((j) => {
      if (!productionJobIsCompleted(j)) return false;
      const d = productionOutputDateISO(j);
      return d && d >= startIso && d <= asOfISO;
    }).length,
  };

  const topCustomers = topCustomersByNetPayments(receipts, data.refunds || [], startIso, asOfISO, 10);
  const materialPerformance = computeMaterialPerformance(data, opts);

  const aging = receivablesAgingBuckets(quotations, ledgerEntries, asOfISO, productionJobs);
  const outstandingReceivablesNgn = Object.values(aging).reduce((s, v) => s + v, 0);

  const trendKeys = [];
  const d0 = new Date(`${toIsoDate(asOfISO)}T12:00:00`);
  const trendBase = Number.isNaN(d0.getTime()) ? new Date() : d0;
  for (let i = 5; i >= 0; i -= 1) {
    const x = new Date(trendBase.getFullYear(), trendBase.getMonth() - i, 1);
    trendKeys.push(`${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`);
  }
  const revenueTrend = trendKeys.map((key) => {
    const mStart = `${key}-01`;
    const mEnd = key === monthKey(asOfISO) ? asOfISO : `${key}-31`;
    return {
      key,
      producedSalesNgn: productionAttributedRevenueNgn(quotations, productionJobs, mStart, mEnd),
      quotedNgn: quotations
        .filter((q) => monthKey(q.dateISO) === key)
        .reduce((s, q) => s + (Number(q.totalNgn) || 0), 0),
    };
  });

  return {
    periodStartISO: startIso,
    periodEndISO: asOfISO,
    periodKey: opts.periodKey || 'month',
    producedRevenueNgn: Math.round(producedRevenueNgn),
    quotedNgn: Math.round(quotedNgn),
    collectedNgn: Math.round(collectedNgn),
    collectionRatePct: quotedNgn > 0 ? Math.round((collectedNgn / quotedNgn) * 1000) / 10 : null,
    mixRows,
    materialPerformance,
    funnel,
    topCustomers,
    receivablesAging: aging,
    outstandingReceivablesNgn: Math.round(outstandingReceivablesNgn),
    revenueTrend,
  };
}

function sumTreasuryInRange(treasuryMovements, startIso, endIso) {
  let inflow = 0;
  let outflow = 0;
  for (const m of treasuryMovements || []) {
    const iso = toIsoDate(m.postedAtISO || m.atISO);
    if (!iso || iso < startIso || iso > endIso) continue;
    if (['INTERNAL_TRANSFER_IN', 'INTERNAL_TRANSFER_OUT'].includes(String(m.type || ''))) continue;
    const amt = Number(m.amountNgn) || 0;
    if (amt >= 0) inflow += amt;
    else outflow += Math.abs(amt);
  }
  return { inflow: Math.round(inflow), outflow: Math.round(outflow), net: Math.round(inflow - outflow) };
}

function pendingOutflowsNgn(paymentRequests, purchaseOrders) {
  let payables = 0;
  for (const pr of paymentRequests || []) {
    if (String(pr.approvalStatus || '').toLowerCase() !== 'approved') continue;
    const req = Number(pr.amountRequestedNgn) || 0;
    const paid = Number(pr.paidAmountNgn) || 0;
    payables += Math.max(0, req - paid);
  }
  for (const po of purchaseOrders || []) {
    const st = String(po.status || '').toLowerCase();
    if (['cancelled', 'canceled'].includes(st)) continue;
    for (const line of po.lines || []) {
      const ordered = (Number(line.qtyOrdered) || 0) * (Number(line.unitPricePerKgNgn || line.unitPriceNgn) || 0);
      const received = (Number(line.qtyReceived) || 0) * (Number(line.unitPricePerKgNgn || line.unitPriceNgn) || 0);
      payables += Math.max(0, ordered - received);
    }
  }
  return Math.round(payables);
}

/**
 * @param {object} data
 * @param {ReturnType<typeof computeSalesAnalytics>} sales
 * @param {ReturnType<typeof computeInventoryAnalytics>} inventory
 * @param {{ periodKey?: BiPeriodKey; asOfISO?: string; procurement?: ReturnType<typeof computeProcurementInsights>; expenseAnalysis?: ReturnType<typeof computeExpenseAnalysis>; productionForecast?: ReturnType<typeof computeProductionForecast>; inventoryForecast?: ReturnType<typeof computeInventoryForecast> }} opts
 */
export function computePredictiveAnalytics(data, sales, inventory, opts = {}) {
  const asOfISO = toIsoDate(opts.asOfISO || new Date().toISOString());
  const lookbackStart = periodStartISO('4months', new Date(`${asOfISO}T12:00:00`));
  const treasury = sumTreasuryInRange(data.treasuryMovements, lookbackStart, asOfISO);
  const monthsSpan = 4;
  const avgMonthlyInflow = Math.round(treasury.inflow / monthsSpan);
  const avgMonthlyOutflow = Math.round(treasury.outflow / monthsSpan);
  const avgMonthlyNet = avgMonthlyInflow - avgMonthlyOutflow;

  const pendingOut = pendingOutflowsNgn(data.paymentRequests, data.purchaseOrders);
  const clearedCashNgn = (data.treasuryAccounts || []).reduce(
    (s, a) => s + (Number(a.balance) || 0),
    0
  );

  const horizons = [30, 60, 90].map((days) => {
    const factor = days / 30;
    const projectedIn = Math.round(avgMonthlyInflow * factor);
    const projectedOut = Math.round(avgMonthlyOutflow * factor + (factor <= 1 ? pendingOut * 0.6 : pendingOut));
    const projectedNet = projectedIn - projectedOut;
    const projectedBalance = clearedCashNgn + projectedNet;
    return {
      days,
      projectedInflowNgn: projectedIn,
      projectedOutflowNgn: projectedOut,
      projectedNetNgn: projectedNet,
      projectedBalanceNgn: projectedBalance,
      stress: projectedBalance < 0 ? 'deficit' : projectedBalance < avgMonthlyOutflow ? 'tight' : 'ok',
    };
  });

  const trend = sales.revenueTrend || [];
  const recent = trend.slice(-3).map((t) => t.producedSalesNgn);
  const prior = trend.slice(-6, -3).map((t) => t.producedSalesNgn);
  const recentAvg = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : 0;
  const priorAvg = prior.length ? prior.reduce((a, b) => a + b, 0) / prior.length : 0;
  const salesMomentumPct =
    priorAvg > 0 ? Math.round(((recentAvg - priorAvg) / priorAvg) * 1000) / 10 : null;

  const cogsEstimateNgn = (data.stockMovements || [])
    .filter((m) => String(m.type || '').includes('CONSUMPTION'))
    .reduce((s, m) => s + Math.abs(Number(m.valueNgn) || 0), 0);
  const grossMarginEstimateNgn = Math.round(sales.producedRevenueNgn - cogsEstimateNgn);
  const grossMarginPct =
    sales.producedRevenueNgn > 0
      ? Math.round((grossMarginEstimateNgn / sales.producedRevenueNgn) * 1000) / 10
      : null;

  /** @type {{ id: string; severity: 'high' | 'medium' | 'low'; category: string; message: string; metric?: string }[]} */
  const alerts = [];

  if (sales.outstandingReceivablesNgn > avgMonthlyInflow && sales.outstandingReceivablesNgn > 0) {
    alerts.push({
      id: 'receivables-heavy',
      severity: 'high',
      category: 'cash',
      message: 'Outstanding receivables exceed typical monthly collections — prioritise follow-up.',
      metric: `₦${sales.outstandingReceivablesNgn.toLocaleString('en-NG')}`,
    });
  }

  for (const fam of inventory.families || []) {
    if (fam.risk === 'critical') {
      alerts.push({
        id: `stock-${fam.family}`,
        severity: 'high',
        category: 'inventory',
        message: `${fam.label} cover is under 2 weeks at current consumption.`,
        metric: fam.weeksCover != null ? `${fam.weeksCover} wk cover` : 'low',
      });
    } else if (fam.risk === 'watch') {
      alerts.push({
        id: `stock-watch-${fam.family}`,
        severity: 'medium',
        category: 'inventory',
        message: `${fam.label} inventory is tightening — review procurement.`,
        metric: fam.weeksCover != null ? `${fam.weeksCover} wk cover` : '',
      });
    }
  }

  const aluMix = sales.mixRows?.find((r) => r.family === 'aluminium');
  const azMix = sales.mixRows?.find((r) => r.family === 'aluzinc');
  if (aluMix && azMix && inventory.families?.length >= 2) {
    const totalMix = (aluMix.sharePct || 0) + (azMix.sharePct || 0);
    if (totalMix > 0) {
      const aluInvShare = inventory.aluminiumSharePct || 0;
      const azInvShare = inventory.aluzincSharePct || 0;
      if (aluMix.sharePct > aluInvShare + 15) {
        alerts.push({
          id: 'mix-alu-mismatch',
          severity: 'medium',
          category: 'mix',
          message: 'Sales skew aluminium but coil stock skews the other way — check production planning.',
        });
      }
      if (azMix.sharePct > azInvShare + 15) {
        alerts.push({
          id: 'mix-az-mismatch',
          severity: 'medium',
          category: 'mix',
          message: 'Aluzinc demand exceeds its share of coil stock — reorder or rebalance.',
        });
      }
    }
  }

  const cash90 = horizons.find((h) => h.days === 90);
  if (cash90?.stress === 'deficit') {
    alerts.push({
      id: 'cash-90-deficit',
      severity: 'high',
      category: 'cash',
      message: '90-day cash projection turns negative at current inflow/outflow rates.',
      metric: `₦${cash90.projectedBalanceNgn.toLocaleString('en-NG')}`,
    });
  } else if (cash90?.stress === 'tight') {
    alerts.push({
      id: 'cash-90-tight',
      severity: 'medium',
      category: 'cash',
      message: 'Cash buffer may be thin within 90 days if collections slow.',
    });
  }

  if (salesMomentumPct != null && salesMomentumPct < -15) {
    alerts.push({
      id: 'sales-down',
      severity: 'medium',
      category: 'sales',
      message: 'Produced sales trend is down versus the prior quarter.',
      metric: `${salesMomentumPct}%`,
    });
  }

  const sku = inventory.skuIntelligence;
  if (sku) {
    for (const fam of ['aluminium', 'aluzinc']) {
      const block = sku[fam];
      if (block?.buyNext?.length) {
        const top = block.buyNext[0];
        alerts.push({
          id: `buy-${fam}-${top.gauge}-${top.colour}`,
          severity: 'medium',
          category: 'procurement',
          message: `Reorder ${fam === 'aluminium' ? 'aluminium' : 'aluzinc'}: ${top.gauge} · ${top.colour} (${top.reason})`,
          metric: top.weeksCover != null ? `${top.weeksCover} wk cover` : 'low cover',
        });
      }
      if (block?.reduceStock?.length) {
        const top = block.reduceStock[0];
        alerts.push({
          id: `liquidate-${fam}-${top.gauge}-${top.colour}`,
          severity: 'medium',
          category: 'inventory',
          message: `Slow coil stock — consider prioritizing sales or transfer: ${top.gauge} · ${top.colour}.`,
          metric: `₦${top.valuationNgn.toLocaleString('en-NG')} tied up`,
        });
      }
    }
  }

  const topSupplier = opts.procurement?.supplierFocus?.[0];
  if (topSupplier && topSupplier.openNgn > 0) {
    alerts.push({
      id: 'supplier-open-commitment',
      severity: 'low',
      category: 'procurement',
      message: `Largest open PO exposure: ${topSupplier.supplierName} — align deliveries and payments.`,
      metric: `₦${topSupplier.openNgn.toLocaleString('en-NG')} open`,
    });
  }

  for (const a of opts.expenseAnalysis?.alerts || []) {
    alerts.push({
      id: a.id,
      severity: a.severity === 'high' ? 'high' : a.severity === 'medium' ? 'medium' : 'low',
      category: 'expenses',
      message: a.message,
      metric: a.metric,
    });
  }

  const prod90 = opts.productionForecast?.horizons?.find((h) => h.days === 90);
  if (prod90 && sales.producedRevenueNgn > 0 && prod90.projectedProducedRevenueNgn < sales.producedRevenueNgn * 0.85) {
    alerts.push({
      id: 'production-forecast-soft',
      severity: 'medium',
      category: 'sales',
      message: '90-day produced-sales forecast is below recent monthly run-rate.',
      metric: `₦${prod90.projectedProducedRevenueNgn.toLocaleString('en-NG')} projected`,
    });
  }

  for (const fam of opts.inventoryForecast?.familyForecasts || []) {
    const h30 = fam.horizons?.find((x) => x.days === 30);
    if (h30?.stockoutRisk) {
      alerts.push({
        id: `inv-stockout-30-${fam.family}`,
        severity: 'high',
        category: 'inventory',
        message: `${fam.label} may stock out within 30 days at current burn rate.`,
        metric: fam.projectedStockoutISO || '30d',
      });
    }
  }

  return {
    asOfISO,
    avgMonthlyInflowNgn: avgMonthlyInflow,
    avgMonthlyOutflowNgn: avgMonthlyOutflow,
    avgMonthlyNetNgn: avgMonthlyNet,
    clearedCashNgn: Math.round(clearedCashNgn),
    pendingOutflowsNgn: pendingOut,
    cashHorizons: horizons,
    salesMomentumPct,
    grossMarginEstimateNgn,
    grossMarginPct,
    alerts: alerts.sort((a, b) => {
      const rank = { high: 0, medium: 1, low: 2 };
      return (rank[a.severity] || 9) - (rank[b.severity] || 9);
    }),
    nextReviewISO: addDaysISO(asOfISO, 7),
  };
}

function expenseDateISO(ex) {
  const raw = String(ex?.date || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return parsed.toISOString().slice(0, 10);
  return toIsoDate(raw);
}

/**
 * Production / sales forecast from monthly produced-revenue trend and funnel.
 * @param {object} data
 * @param {ReturnType<typeof computeSalesAnalytics>} sales
 * @param {{ periodKey?: BiPeriodKey; asOfISO?: string }} opts
 */
export function computeProductionForecast(data, sales, opts = {}) {
  const asOfISO = toIsoDate(opts.asOfISO || new Date().toISOString());
  const quotations = data.quotations || [];
  const productionJobs = data.productionJobs || [];

  const trend = sales.revenueTrend || [];
  const monthlyValues = trend.map((t) => t.producedSalesNgn || 0);
  const recent3 = monthlyValues.slice(-3);
  const prior3 = monthlyValues.slice(-6, -3);
  const recentAvg = recent3.length ? recent3.reduce((a, b) => a + b, 0) / recent3.length : 0;
  const priorAvg = prior3.length ? prior3.reduce((a, b) => a + b, 0) / prior3.length : 0;
  const growthRatePct =
    priorAvg > 0 ? Math.round(((recentAvg - priorAvg) / priorAvg) * 1000) / 10 : null;

  const monthlyMetres = trend.map((t) => {
    const mStart = `${t.key}-01`;
    const mEnd = t.key === monthKey(asOfISO) ? asOfISO : `${t.key}-31`;
    let metres = 0;
    let jobs = 0;
    for (const j of productionJobs) {
      if (!productionJobIsCompleted(j)) continue;
      const d = productionOutputDateISO(j);
      if (!d || d < mStart || d > mEnd) continue;
      metres += Number(j.actualMeters) || 0;
      jobs += 1;
    }
    return { key: t.key, metres: Math.round(metres), jobs, producedSalesNgn: t.producedSalesNgn };
  });

  const avgMonthlyRevenue = monthlyValues.length
    ? monthlyValues.reduce((a, b) => a + b, 0) / monthlyValues.length
    : 0;
  const avgMonthlyMetres = monthlyMetres.length
    ? monthlyMetres.reduce((s, m) => s + m.metres, 0) / monthlyMetres.length
    : 0;

  const growthFactor = growthRatePct != null ? 1 + Math.min(0.5, Math.max(-0.5, growthRatePct / 100)) : 1;

  const horizons = [30, 60, 90].map((days) => {
    const factor = (days / 30) * growthFactor;
    return {
      days,
      projectedProducedRevenueNgn: Math.round(avgMonthlyRevenue * factor),
      projectedMetres: Math.round(avgMonthlyMetres * factor),
      confidence: monthlyValues.filter((v) => v > 0).length >= 3 ? 'medium' : 'low',
    };
  });

  const funnel = sales.funnel || {};
  const quoteToProductionPct =
    funnel.quotations > 0
      ? Math.round((funnel.productionCompleted / funnel.quotations) * 1000) / 10
      : null;
  const quoteToPaymentPct =
    funnel.quotations > 0
      ? Math.round((funnel.withPayment / funnel.quotations) * 1000) / 10
      : null;

  const lookbackStart = periodStartISO('month', new Date(`${asOfISO}T12:00:00`));
  let pipelineQuotedNgn = 0;
  let pipelineMetres = 0;
  for (const q of quotations) {
    const d = toIsoDate(q.dateISO);
    if (!d || d < lookbackStart || d > asOfISO) continue;
    const ref = String(q.id || '').trim();
    const hasProduction = productionJobs.some(
      (j) =>
        productionJobIsCompleted(j) &&
        String(j.quotationRef || '').trim() === ref &&
        productionOutputDateISO(j) >= lookbackStart
    );
    if (hasProduction) continue;
    if (!/approved|paid|partial|requested/i.test(String(q.status || ''))) continue;
    pipelineQuotedNgn += Number(q.totalNgn) || 0;
    pipelineMetres += Number(q.totalMeters) || 0;
  }

  const conversionFactor = quoteToProductionPct != null ? quoteToProductionPct / 100 : 0.65;
  const pipelineForecastRevenueNgn = Math.round(pipelineQuotedNgn * conversionFactor);

  return {
    asOfISO,
    monthlyHistory: monthlyMetres,
    growthRatePct,
    avgMonthlyProducedRevenueNgn: Math.round(avgMonthlyRevenue),
    avgMonthlyMetres: Math.round(avgMonthlyMetres),
    horizons,
    funnelConversion: {
      quoteToProductionPct,
      quoteToPaymentPct,
      quotations: funnel.quotations,
      productionCompleted: funnel.productionCompleted,
    },
    pipeline: {
      openQuotedNgn: Math.round(pipelineQuotedNgn),
      openMetres: Math.round(pipelineMetres),
      forecastProducedRevenueNgn: pipelineForecastRevenueNgn,
      assumedConversionPct: Math.round(conversionFactor * 1000) / 10,
    },
  };
}

/**
 * Inventory consumption forecast by metal family and enriched SKU reorder lines.
 * @param {object} data
 * @param {ReturnType<typeof computeInventoryAnalytics>} inventory
 * @param {{ periodKey?: BiPeriodKey; asOfISO?: string }} opts
 */
export function computeInventoryForecast(data, inventory, opts = {}) {
  const asOfISO = toIsoDate(opts.asOfISO || new Date().toISOString());
  const startIso = periodStartISO(opts.periodKey || 'month', new Date(`${asOfISO}T12:00:00`));
  const windowDays = daysBetween(startIso, asOfISO);
  const sku = inventory.skuIntelligence;

  const enrichSkuRow = (row) => {
    const dailyDemand = row.kgDemandPeriod > 0 ? row.kgDemandPeriod / windowDays : 0;
    const stockoutDays = dailyDemand > 0 ? row.kgOnHand / dailyDemand : null;
    const weeksTarget = 4;
    const targetKg = dailyDemand * weeksTarget * 7;
    const suggestedOrderKg = Math.max(0, Math.round(targetKg - row.kgOnHand));
    return {
      ...row,
      dailyDemandKg: Math.round(dailyDemand * 10) / 10,
      projectedStockoutISO:
        stockoutDays != null && stockoutDays < 365
          ? addDaysISO(asOfISO, Math.ceil(stockoutDays))
          : null,
      suggestedOrderKg,
      weeksTarget,
    };
  };

  const familyForecasts = (inventory.families || []).map((fam) => {
    const daily = Number(fam.dailyConsumptionKg) || 0;
    const horizons = [30, 60, 90].map((days) => {
      const burn = daily * days;
      const remaining = fam.kgOnHand + (fam.incomingKg || 0) - burn;
      return {
        days,
        projectedConsumptionKg: Math.round(burn),
        projectedKgOnHand: Math.round(remaining),
        stockoutRisk: daily > 0 && remaining < 0,
      };
    });
    const stockoutDays =
      daily > 0 ? Math.round((fam.kgOnHand / daily) * 10) / 10 : null;
    return {
      family: fam.family,
      label: fam.label,
      kgOnHand: fam.kgOnHand,
      incomingKg: fam.incomingKg,
      dailyConsumptionKg: daily,
      weeksCover: fam.weeksCover,
      stockoutDays,
      projectedStockoutISO:
        stockoutDays != null && stockoutDays < 365
          ? addDaysISO(asOfISO, Math.ceil(stockoutDays))
          : null,
      suggestedOrderKg:
        daily > 0
          ? Math.max(0, Math.round(daily * 28 - fam.kgOnHand))
          : 0,
      horizons,
    };
  });

  return {
    asOfISO,
    periodStartISO: startIso,
    familyForecasts,
    aluminium: sku?.aluminium
      ? {
          buyNext: (sku.aluminium.buyNext || []).map(enrichSkuRow),
          reduceStock: sku.aluminium.reduceStock || [],
          needsAttention: (sku.aluminium.needsAttention || []).map(enrichSkuRow),
        }
      : null,
    aluzinc: sku?.aluzinc
      ? {
          buyNext: (sku.aluzinc.buyNext || []).map(enrichSkuRow),
          reduceStock: sku.aluzinc.reduceStock || [],
          needsAttention: (sku.aluzinc.needsAttention || []).map(enrichSkuRow),
        }
      : null,
  };
}

/**
 * Operating expense analysis — categories, trend, and ratio to produced sales.
 * @param {object} data
 * @param {ReturnType<typeof computeSalesAnalytics>} sales
 * @param {{ periodKey?: BiPeriodKey; asOfISO?: string }} opts
 */
export function computeExpenseAnalysis(data, sales, opts = {}) {
  const { startIso, endIso: asOfISO } = resolveBiPeriodBounds(opts);
  const windowDays = daysBetween(startIso, asOfISO);
  const priorEnd = addDaysISO(startIso, -1);
  const priorStart = addDaysISO(startIso, -windowDays);

  const expenses = data.expenses || [];
  let periodTotal = 0;
  let priorTotal = 0;
  /** @type {Map<string, number>} */
  const byCategory = new Map();
  /** @type {Map<string, number>} */
  const byBranch = new Map();
  /** @type {object[]} */
  const lineItems = [];

  for (const ex of expenses) {
    const iso = expenseDateISO(ex);
    if (!iso) continue;
    const amt = Math.round(Number(ex.amountNgn) || 0);
    if (amt <= 0) continue;
    const cat = String(ex.category || ex.expenseType || 'Uncategorized').trim() || 'Uncategorized';
    const branch = String(ex.branchId || 'UNASSIGNED').trim() || 'UNASSIGNED';

    if (iso >= startIso && iso <= asOfISO) {
      periodTotal += amt;
      byCategory.set(cat, (byCategory.get(cat) || 0) + amt);
      byBranch.set(branch, (byBranch.get(branch) || 0) + amt);
      lineItems.push({
        expenseID: ex.expenseID,
        dateISO: iso,
        category: cat,
        branchId: branch,
        amountNgn: amt,
        reference: ex.reference || '',
      });
    } else if (iso >= priorStart && iso <= priorEnd) {
      priorTotal += amt;
    }
  }

  lineItems.sort((a, b) => b.amountNgn - a.amountNgn);

  const periodChangePct =
    priorTotal > 0 ? Math.round(((periodTotal - priorTotal) / priorTotal) * 1000) / 10 : null;

  const d0 = new Date(`${toIsoDate(asOfISO)}T12:00:00`);
  const trendBase = Number.isNaN(d0.getTime()) ? new Date() : d0;
  const monthlyTrend = [];
  for (let i = 5; i >= 0; i -= 1) {
    const x = new Date(trendBase.getFullYear(), trendBase.getMonth() - i, 1);
    const key = `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}`;
    const mStart = `${key}-01`;
    const mEnd = key === monthKey(asOfISO) ? asOfISO : `${key}-31`;
    let sum = 0;
    for (const ex of expenses) {
      const iso = expenseDateISO(ex);
      if (!iso || iso < mStart || iso > mEnd) continue;
      sum += Math.round(Number(ex.amountNgn) || 0);
    }
    monthlyTrend.push({ key, amountNgn: sum });
  }

  const avgMonthly =
    monthlyTrend.length > 0
      ? Math.round(monthlyTrend.reduce((s, m) => s + m.amountNgn, 0) / monthlyTrend.length)
      : 0;

  const producedRevenue = sales.producedRevenueNgn || 0;
  const expenseToSalesPct =
    producedRevenue > 0 ? Math.round((periodTotal / producedRevenue) * 1000) / 10 : null;

  const topCategories = [...byCategory.entries()]
    .map(([category, amountNgn]) => ({
      category,
      amountNgn,
      sharePct: periodTotal > 0 ? Math.round((amountNgn / periodTotal) * 1000) / 10 : 0,
    }))
    .sort((a, b) => b.amountNgn - a.amountNgn)
    .slice(0, 12);

  const byBranchRows = [...byBranch.entries()]
    .map(([branchId, amountNgn]) => ({ branchId, amountNgn }))
    .sort((a, b) => b.amountNgn - a.amountNgn);

  /** @type {{ id: string; severity: string; message: string; metric?: string }[]} */
  const alerts = [];
  if (periodChangePct != null && periodChangePct > 25) {
    alerts.push({
      id: 'expense-spike',
      severity: 'medium',
      message: 'Operating expenses are up sharply versus the prior period.',
      metric: `+${periodChangePct}%`,
    });
  }
  if (expenseToSalesPct != null && expenseToSalesPct > 40) {
    alerts.push({
      id: 'expense-ratio-high',
      severity: 'medium',
      message: 'Expenses exceed 40% of produced sales in this period — review spend.',
      metric: `${expenseToSalesPct}%`,
    });
  }
  const topCat = topCategories[0];
  if (topCat && topCat.sharePct > 45) {
    alerts.push({
      id: 'expense-category-dominant',
      severity: 'low',
      message: `${topCat.category} dominates spend — check if expected.`,
      metric: `${topCat.sharePct}%`,
    });
  }

  return {
    asOfISO,
    periodStartISO: startIso,
    periodEndISO: asOfISO,
    periodTotalNgn: periodTotal,
    priorPeriodTotalNgn: priorTotal,
    periodChangePct,
    avgMonthlyExpenseNgn: avgMonthly,
    projectedNext30DaysNgn: Math.round(avgMonthly),
    expenseToProducedSalesPct: expenseToSalesPct,
    monthlyTrend,
    topCategories,
    byBranch: byBranchRows,
    topExpenses: lineItems.slice(0, 15),
    alerts,
  };
}

/**
 * @param {object} data — ERP snapshot slices
 * @param {{ periodKey?: BiPeriodKey; branchScope?: string; asOfISO?: string }} opts
 */
export function buildBusinessIntelligencePack(data, opts = {}) {
  const asOfISO = toIsoDate(opts.asOfISO || new Date().toISOString());
  const periodKey = opts.periodKey || 'month';
  const periodMeta = BI_PERIOD_OPTIONS.find((p) => p.key === periodKey) || BI_PERIOD_OPTIONS[0];

  const inventory = computeInventoryAnalytics(data, { periodKey, asOfISO });
  const sales = computeSalesAnalytics(data, { periodKey, asOfISO });
  const procurement = computeProcurementInsights(data, { periodKey, asOfISO });
  const branchBreakdown = computeBranchBreakdown(data, {
    periodKey,
    asOfISO,
    branchScope: opts.branchScope || 'ALL',
  });
  const productionForecast = computeProductionForecast(data, sales, { periodKey, asOfISO });
  const inventoryForecast = computeInventoryForecast(data, inventory, { periodKey, asOfISO });
  const expenseAnalysis = computeExpenseAnalysis(data, sales, { periodKey, asOfISO });
  const predictive = computePredictiveAnalytics(data, sales, inventory, {
    periodKey,
    asOfISO,
    procurement,
    expenseAnalysis,
    productionForecast,
    inventoryForecast,
  });

  return {
    ok: true,
    engineRev: BI_ENGINE_REV,
    generatedAtISO: new Date().toISOString(),
    asOfISO,
    periodKey,
    periodLabel: periodMeta.label,
    branchScope: opts.branchScope || 'ALL',
    inventory,
    inventoryForecast,
    sales,
    productionForecast,
    expenseAnalysis,
    procurement,
    branchBreakdown,
    predictive,
  };
}

/**
 * Permission-safe headline lines for Zare / briefing (no customer PII).
 * @param {ReturnType<typeof buildBusinessIntelligencePack>} pack
 */
export function businessIntelligenceHeadlines(pack) {
  if (!pack?.ok) return [];
  const lines = [];
  const s = pack.sales;
  const p = pack.predictive;
  lines.push(
    `Produced sales (${pack.periodLabel}): ₦${(s.producedRevenueNgn || 0).toLocaleString('en-NG')}.`
  );
  if (s.outstandingReceivablesNgn > 0) {
    lines.push(
      `Outstanding receivables (production complete, balance due): ₦${s.outstandingReceivablesNgn.toLocaleString('en-NG')}.`
    );
  }
  for (const fam of pack.inventory?.families || []) {
    const cover = fam.weeksCover != null ? `${fam.weeksCover} wk cover` : 'no consumption rate';
    lines.push(`${fam.label}: ${fam.kgOnHand.toLocaleString()} kg on hand (${cover}).`);
  }
  const topPay = pack.sales?.topCustomers?.[0];
  if (topPay?.netCollectedNgn > 0) {
    lines.push(
      `Top payer (${pack.periodLabel}): ${topPay.customerName} — ₦${topPay.netCollectedNgn.toLocaleString('en-NG')} net collected.`
    );
  }
  const topMat = pack.sales?.materialPerformance?.aluminium?.topCombinations?.[0];
  if (topMat?.metres > 0) {
    lines.push(
      `Best alu combo (by metres): ${topMat.gauge} · ${topMat.colour} · ${topMat.profile} — ${topMat.metres.toLocaleString()} m produced (${topMat.sharePctMetres ?? 0}% of alu metres).`
    );
  }
  const pf = pack.productionForecast?.horizons?.find((h) => h.days === 30);
  if (pf) {
    lines.push(
      `30-day production forecast: ₦${pf.projectedProducedRevenueNgn.toLocaleString('en-NG')} · ${pf.projectedMetres.toLocaleString()} m.`
    );
  }
  const ex = pack.expenseAnalysis;
  if (ex?.periodTotalNgn > 0) {
    lines.push(
      `Expenses (${pack.periodLabel}): ₦${ex.periodTotalNgn.toLocaleString('en-NG')}${ex.expenseToProducedSalesPct != null ? ` (${ex.expenseToProducedSalesPct}% of produced sales)` : ''}.`
    );
  }
  const invF = pack.inventoryForecast?.familyForecasts?.find((f) => f.stockoutDays != null && f.stockoutDays < 14);
  if (invF) {
    lines.push(`${invF.label} stock cover critical — ~${invF.stockoutDays} days at current consumption.`);
  }
  const h90 = p.cashHorizons?.find((x) => x.days === 90);
  if (h90) {
    lines.push(
      `90-day cash outlook: ₦${h90.projectedBalanceNgn.toLocaleString('en-NG')} projected balance (${h90.stress}).`
    );
  }
  for (const a of (p.alerts || []).slice(0, 3)) {
    lines.push(`⚠ ${a.message}`);
  }
  return lines.slice(0, 8);
}
