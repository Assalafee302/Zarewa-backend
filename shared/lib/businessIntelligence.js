/**
 * Business intelligence — sales mix, aluminium/aluzinc inventory, and predictive cash signals.
 * Pure functions over workspace / ERP snapshots (shared by API and Zare).
 */
import { amountDueOnQuotationFromEntries } from './customerLedgerCore.js';
import { materialFamilyKeyForConversion } from './coilMaterialFamily.js';
import {
  allocatedQuotationRevenueForProductionJob,
  metersProducedByQuotationRef,
  productionAttributedRevenueNgn,
  productionOutputDateISO,
  receivablesAgingBuckets,
} from './liveAnalytics.js';

const ALU_PRODUCT_IDS = new Set(['COIL-ALU', 'MAT-001']);
const ALUZ_PRODUCT_IDS = new Set(['PRD-102', 'MAT-002']);
const COIL_FAMILIES = ['aluminium', 'aluzinc'];

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
    if (!d || d < startIso || d > asOfISO) continue;
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
  return {
    asOfISO,
    periodKey: opts.periodKey || 'month',
    families,
    totalCoilKg: totalKg,
    aluminiumSharePct:
      totalKg > 0 ? Math.round((families[0].kgOnHand / totalKg) * 1000) / 10 : 0,
    aluzincSharePct:
      totalKg > 0 ? Math.round((families[1].kgOnHand / totalKg) * 1000) / 10 : 0,
  };
}

/**
 * @param {object} data
 * @param {{ periodKey?: BiPeriodKey; asOfISO?: string }} opts
 */
export function computeSalesAnalytics(data, opts = {}) {
  const asOfISO = toIsoDate(opts.asOfISO || new Date().toISOString());
  const startIso = periodStartISO(opts.periodKey || 'month', new Date(`${asOfISO}T12:00:00`));
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

  const mixRows = Object.values(mix).map((row) => ({
    ...row,
    revenueNgn: Math.round(row.revenueNgn),
    sharePct: producedRevenueNgn > 0 ? Math.round((row.revenueNgn / producedRevenueNgn) * 1000) / 10 : 0,
  }));

  const qInPeriod = quotations.filter((q) => {
    const d = toIsoDate(q.dateISO);
    return d && d >= startIso && d <= asOfISO;
  });

  const receiptsInPeriod = receipts.filter((r) => {
    const d = toIsoDate(r.dateISO || r.date);
    return d && d >= startIso && d <= asOfISO;
  });

  const collectedNgn = receiptsInPeriod.reduce((s, r) => s + (Number(r.amountNgn) || 0), 0);
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

  /** @type {Map<string, { customerID: string; customerName: string; revenueNgn: number; metres: number }>} */
  const byCustomer = new Map();
  for (const q of qInPeriod) {
    const cid = String(q.customerID || q.customer || '').trim();
    if (!cid) continue;
    const curr = byCustomer.get(cid) || {
      customerID: cid,
      customerName: q.customer || cid,
      revenueNgn: 0,
      metres: 0,
    };
    curr.revenueNgn += Number(q.totalNgn) || 0;
    byCustomer.set(cid, curr);
  }
  const topCustomers = [...byCustomer.values()]
    .sort((a, b) => b.revenueNgn - a.revenueNgn)
    .slice(0, 10)
    .map((r) => ({ ...r, revenueNgn: Math.round(r.revenueNgn) }));

  const aging = receivablesAgingBuckets(quotations, ledgerEntries, asOfISO);
  const outstandingReceivablesNgn = Object.values(aging).reduce((s, v) => s + v, 0);

  const trendKeys = [];
  const d0 = new Date(`${asOfISO}T12:00:00`);
  for (let i = 5; i >= 0; i -= 1) {
    const x = new Date(d0.getFullYear(), d0.getMonth() - i, 1);
    trendKeys.push(x.toISOString().slice(0, 7));
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
 * @param {{ periodKey?: BiPeriodKey; asOfISO?: string }} opts
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
    const aluInv = inventory.families[0];
    const azInv = inventory.families[1];
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
  const predictive = computePredictiveAnalytics(data, sales, inventory, { periodKey, asOfISO });

  return {
    ok: true,
    generatedAtISO: new Date().toISOString(),
    asOfISO,
    periodKey,
    periodLabel: periodMeta.label,
    branchScope: opts.branchScope || 'ALL',
    inventory,
    sales,
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
    lines.push(`Outstanding receivables: ₦${s.outstandingReceivablesNgn.toLocaleString('en-NG')}.`);
  }
  for (const fam of pack.inventory?.families || []) {
    const cover = fam.weeksCover != null ? `${fam.weeksCover} wk cover` : 'no consumption rate';
    lines.push(`${fam.label}: ${fam.kgOnHand.toLocaleString()} kg on hand (${cover}).`);
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
