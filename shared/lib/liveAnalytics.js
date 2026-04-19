import { amountDueOnQuotationFromEntries } from './customerLedgerCore.js';
import { refundOutstandingAmount } from './refundsStore.js';
import { receiptCashReceivedNgn } from './salesReceiptsList.js';

function toIsoDate(value) {
  return String(value || '').slice(0, 10);
}

function monthKey(iso) {
  const d = toIsoDate(iso);
  return d ? d.slice(0, 7) : '';
}

function monthLabel(key) {
  const [y, m] = String(key).split('-');
  const idx = Number(m) - 1;
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return y && idx >= 0 && idx < 12 ? `${names[idx]} ${y}` : key;
}

function parseMeters(totalLabel) {
  const m = String(totalLabel ?? '').match(/([\d,.]+)\s*m/i);
  return m ? Number(String(m[1]).replace(/,/g, '')) || 0 : 0;
}

function cuttingMeters(row) {
  return Number(row?.totalMeters) || parseMeters(row?.total);
}

function productionJobIsCompleted(job) {
  return String(job?.status || '').trim() === 'Completed';
}

/**
 * Calendar date for recorded production output (differs from quotation date and cutting-list date).
 * Uses completion timestamp, then end date.
 */
export function productionOutputDateISO(job) {
  return toIsoDate(job?.completedAtISO || job?.endDateISO || '');
}

function productionJobActualMeters(job) {
  return Number(job?.actualMeters) || 0;
}

/** Sum of actual metres from completed production jobs per quotation ref (split denominator for attributed sales). */
export function metersProducedByQuotationRef(productionJobs = []) {
  const map = new Map();
  for (const j of productionJobs) {
    if (!productionJobIsCompleted(j)) continue;
    const ref = String(j.quotationRef || '').trim();
    if (!ref) continue;
    const m = productionJobActualMeters(j);
    if (m <= 0) continue;
    map.set(ref, (map.get(ref) || 0) + m);
  }
  return map;
}

/**
 * Share of quotation total for one completed job (by actual metres vs all completed output for that quote).
 */
export function allocatedQuotationRevenueForProductionJob(job, quotation, metersProducedByRef) {
  const ref = String(job.quotationRef || '').trim();
  if (!ref || !quotation || !productionJobIsCompleted(job)) return 0;
  const quoteTotal = Number(quotation.totalNgn) || 0;
  if (quoteTotal <= 0) return 0;
  const jm = productionJobActualMeters(job);
  if (jm <= 0) return 0;
  const denom = metersProducedByRef.get(ref) || jm || 1;
  return quoteTotal * (jm / denom);
}

/** Total metres per quotation ref across all cutting lists (planning / dispatch — not produced metres). */
export function metersTotalsByQuotationRef(cuttingLists = []) {
  const map = new Map();
  for (const cl of cuttingLists) {
    const ref = String(cl.quotationRef || '').trim();
    if (!ref) continue;
    map.set(ref, (map.get(ref) || 0) + cuttingMeters(cl));
  }
  return map;
}

/**
 * Share of quotation total attributed to one cutting list (by metre share across all lists for that quote).
 * @param {object} cl cutting list row
 * @param {object | undefined} quotation
 * @param {Map<string, number>} metersByQuoteRef from {@link metersTotalsByQuotationRef}
 */
export function allocatedQuotationRevenueForCuttingList(cl, quotation, metersByQuoteRef) {
  const ref = String(cl.quotationRef || '').trim();
  if (!ref || !quotation) return 0;
  const quoteTotal = Number(quotation.totalNgn) || 0;
  if (quoteTotal <= 0) return 0;
  const clM = cuttingMeters(cl);
  const denom = metersByQuoteRef.get(ref) || clM || 1;
  return quoteTotal * (clM / denom);
}

function weekStart(iso) {
  const d = new Date(`${toIsoDate(iso)}T00:00:00`);
  if (Number.isNaN(d.getTime())) return '';
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}

function lastMonthKeys(count = 6, baseDate = new Date()) {
  const keys = [];
  const d = new Date(baseDate.getFullYear(), baseDate.getMonth(), 1);
  for (let i = count - 1; i >= 0; i -= 1) {
    const x = new Date(d.getFullYear(), d.getMonth() - i, 1);
    keys.push(x.toISOString().slice(0, 7));
  }
  return keys;
}

function lastWeekKeys(count = 8, baseDate = new Date()) {
  const keys = [];
  const base = weekStart(baseDate.toISOString().slice(0, 10));
  const d = new Date(`${base}T00:00:00`);
  for (let i = count - 1; i >= 0; i -= 1) {
    const x = new Date(d);
    x.setDate(x.getDate() - i * 7);
    keys.push(x.toISOString().slice(0, 10));
  }
  return keys;
}

/** Quotation totals by month (quote date). Order-book / pipeline — not sales until material is produced (cutting lists). */
export function liveSalesSeriesByMonth(quotations = [], count = 6) {
  const keys = lastMonthKeys(count);
  const sums = new Map(keys.map((k) => [k, 0]));
  quotations.forEach((q) => {
    const key = monthKey(q.dateISO);
    if (sums.has(key)) sums.set(key, (sums.get(key) || 0) + (Number(q.totalNgn) || 0));
  });
  return keys.map((key) => ({ key, period: monthLabel(key), amountNgn: sums.get(key) || 0 }));
}

/** Same as {@link liveSalesSeriesByMonth} but by ISO week start of quotation date. */
export function liveSalesSeriesByWeek(quotations = [], count = 8) {
  const keys = lastWeekKeys(count);
  const sums = new Map(keys.map((k) => [k, 0]));
  quotations.forEach((q) => {
    const key = weekStart(q.dateISO);
    if (sums.has(key)) sums.set(key, (sums.get(key) || 0) + (Number(q.totalNgn) || 0));
  });
  return keys.map((key) => ({ key, period: key.slice(5), amountNgn: sums.get(key) || 0 }));
}

/** Sales (₦) by month from production completion dates; quote total split by actual metres across completed jobs per quote. */
export function liveProductionAttributedSalesSeriesByMonth(quotations = [], productionJobs = [], count = 6) {
  const keys = lastMonthKeys(count);
  const sums = new Map(keys.map((k) => [k, 0]));
  const qById = new Map(quotations.map((q) => [String(q.id || '').trim(), q]));
  const metersByRef = metersProducedByQuotationRef(productionJobs);
  for (const j of productionJobs) {
    if (!productionJobIsCompleted(j)) continue;
    const iso = productionOutputDateISO(j);
    if (!iso) continue;
    const key = monthKey(iso);
    if (!sums.has(key)) continue;
    const ref = String(j.quotationRef || '').trim();
    const q = qById.get(ref);
    const alloc = allocatedQuotationRevenueForProductionJob(j, q, metersByRef);
    sums.set(key, (sums.get(key) || 0) + alloc);
  }
  return keys.map((key) => ({ key, period: monthLabel(key), amountNgn: Math.round(sums.get(key) || 0) }));
}

/** Same as {@link liveProductionAttributedSalesSeriesByMonth} but by week start of production completion. */
export function liveProductionAttributedSalesSeriesByWeek(quotations = [], productionJobs = [], count = 8) {
  const keys = lastWeekKeys(count);
  const sums = new Map(keys.map((k) => [k, 0]));
  const qById = new Map(quotations.map((q) => [String(q.id || '').trim(), q]));
  const metersByRef = metersProducedByQuotationRef(productionJobs);
  for (const j of productionJobs) {
    if (!productionJobIsCompleted(j)) continue;
    const iso = productionOutputDateISO(j);
    if (!iso) continue;
    const wk = weekStart(iso);
    if (!sums.has(wk)) continue;
    const ref = String(j.quotationRef || '').trim();
    const q = qById.get(ref);
    const alloc = allocatedQuotationRevenueForProductionJob(j, q, metersByRef);
    sums.set(wk, (sums.get(wk) || 0) + alloc);
  }
  return keys.map((key) => ({ key, period: key.slice(5), amountNgn: Math.round(sums.get(key) || 0) }));
}

/** Metres produced by calendar month (completed jobs only; dated by production completion). */
export function liveMetersSeries(productionJobs = [], count = 6) {
  const keys = lastMonthKeys(count);
  const sums = new Map(keys.map((k) => [k, 0]));
  for (const j of productionJobs) {
    if (!productionJobIsCompleted(j)) continue;
    const iso = productionOutputDateISO(j);
    if (!iso) continue;
    const key = monthKey(iso);
    if (!sums.has(key)) continue;
    sums.set(key, (sums.get(key) || 0) + productionJobActualMeters(j));
  }
  return keys.map((key) => ({ key, label: monthLabel(key), meters: sums.get(key) || 0 }));
}

export function liveLiquidityBreakdown(accounts = []) {
  return accounts.map((a) => ({
    label: `${a.type} — ${a.name}`,
    amountNgn: Number(a.balance) || 0,
  }));
}

export function totalLiquidityNgn(accounts = []) {
  return accounts.reduce((s, a) => s + (Number(a.balance) || 0), 0);
}

export function liveStockMix(products = []) {
  const byType = new Map();
  products.forEach((p) => {
    const key = p.dashboardAttrs?.materialType || p.name || 'Other';
    byType.set(key, (byType.get(key) || 0) + (Number(p.stockLevel) || 0));
  });
  return [...byType.entries()]
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value)
    .slice(0, 5);
}

export function liveCashflowMonthly(receipts = [], expenses = [], count = 6, treasuryMovements = []) {
  const keys = lastMonthKeys(count);
  const income = new Map(keys.map((k) => [k, 0]));
  const expense = new Map(keys.map((k) => [k, 0]));
  if (Array.isArray(treasuryMovements) && treasuryMovements.length > 0) {
    treasuryMovements.forEach((m) => {
      if (['INTERNAL_TRANSFER_IN', 'INTERNAL_TRANSFER_OUT'].includes(m.type)) return;
      const key = monthKey(m.postedAtISO);
      if (!income.has(key)) return;
      const amount = Number(m.amountNgn) || 0;
      if (amount > 0) income.set(key, (income.get(key) || 0) + amount);
      else expense.set(key, (expense.get(key) || 0) + Math.abs(amount));
    });
    return keys.map((key) => ({
      month: key.slice(5),
      income: Math.round(((income.get(key) || 0) / 1e6) * 10) / 10,
      expense: Math.round(((expense.get(key) || 0) / 1e6) * 10) / 10,
    }));
  }
  receipts.forEach((r) => {
    const key = monthKey(r.dateISO);
    if (income.has(key)) income.set(key, (income.get(key) || 0) + receiptCashReceivedNgn(r));
  });
  expenses.forEach((e) => {
    const key = monthKey(e.date);
    if (expense.has(key)) expense.set(key, (expense.get(key) || 0) + (Number(e.amountNgn) || 0));
  });
  return keys.map((key) => ({
    month: key.slice(5),
    income: Math.round((income.get(key) || 0) / 1e6 * 10) / 10,
    expense: Math.round((expense.get(key) || 0) / 1e6 * 10) / 10,
  }));
}

/** Align with sales-side rough yield (kg ↔ m) — planning estimate, not dispatch truth. */
function roughKgFromMeters(meters, gaugeMmNum) {
  const m = Number(meters);
  if (!Number.isFinite(m) || m <= 0) return 0;
  const g = Number(gaugeMmNum) > 0 ? Number(gaugeMmNum) : 0.26;
  const kgPerM = g <= 0.22 ? 2.35 : g <= 0.26 ? 2.65 : g <= 0.3 ? 2.9 : g <= 0.45 ? 3.4 : 3.8;
  return Math.round(m * kgPerM);
}

function materialSpecFromQuotation(q) {
  if (!q) return { colour: '—', gauge: '—', profile: '—' };
  const colour = String(q.materialColor ?? q.material_color ?? q.color ?? '').trim();
  const gauge = String(q.materialGauge ?? q.material_gauge ?? q.gauge ?? '').trim();
  const profile = String(q.materialDesign ?? q.material_design ?? q.profile ?? '').trim();
  return {
    colour: colour || '—',
    gauge: gauge || '—',
    profile: profile || '—',
  };
}

function monthToDateRangeISO(base = new Date()) {
  const end = base instanceof Date && !Number.isNaN(base.getTime()) ? base : new Date();
  const start = new Date(end.getFullYear(), end.getMonth(), 1);
  return { startIso: start.toISOString().slice(0, 10), endIso: end.toISOString().slice(0, 10) };
}

/**
 * Top material combinations (colour × gauge × profile) by sales in a date range.
 * Metres produced = actual metres from completed production jobs; dated by production completion.
 */
export function liveTopSalesPerformersByMaterial(productionJobs = [], quotations = [], opts = {}) {
  const { limit = 5 } = opts;
  const { startIso, endIso } = opts.startIso && opts.endIso ? opts : monthToDateRangeISO();

  const quoteById = new Map();
  (quotations || []).forEach((q) => {
    if (q?.id) quoteById.set(q.id, q);
  });

  const metersByRef = metersProducedByQuotationRef(productionJobs || []);
  const buckets = new Map();
  for (const j of productionJobs || []) {
    if (!productionJobIsCompleted(j)) continue;
    const d = productionOutputDateISO(j);
    if (!d || d < startIso || d > endIso) continue;
    const m = productionJobActualMeters(j);
    if (m <= 0) continue;
    const ref = String(j.quotationRef || '').trim();
    const q = quoteById.get(ref);
    const spec = materialSpecFromQuotation(q);
    const key = `${spec.colour}\0${spec.gauge}\0${spec.profile}`;
    let row = buckets.get(key);
    if (!row) {
      const gaugeMm = Number(String(spec.gauge || '').match(/(\d+(?:\.\d+)?)/)?.[1]) || 0;
      row = {
        colour: spec.colour,
        gaugeRaw: spec.gauge,
        gaugeMm,
        materialType: spec.profile,
        metresProduced: 0,
        revenueNgn: 0,
      };
      buckets.set(key, row);
    }
    row.metresProduced += m;
    row.revenueNgn += allocatedQuotationRevenueForProductionJob(j, q, metersByRef);
  }

  const rows = [...buckets.values()].map((row) => {
    const weightKg = roughKgFromMeters(row.metresProduced, row.gaugeMm);
    return {
      colour: row.colour,
      gaugeRaw: row.gaugeRaw,
      gaugeMm: row.gaugeMm,
      materialType: row.materialType,
      metresProduced: row.metresProduced,
      weightKg,
      revenueNgn: Math.round(row.revenueNgn),
    };
  });

  rows.sort((a, b) => (b.revenueNgn - a.revenueNgn) || (b.metresProduced - a.metresProduced));
  const capped = limit == null ? rows : rows.slice(0, limit);
  return capped.map((r, i) => ({ ...r, rank: i + 1 }));
}

export function liveProductionPulse(productionJobs = [], movements = [], wipByProduct = {}, coilRequests = []) {
  const now = new Date();
  const sevenDaysAgo = new Date(now);
  sevenDaysAgo.setDate(now.getDate() - 7);
  const cutoff = sevenDaysAgo.toISOString().slice(0, 10);

  const metresProduced7d = productionJobs
    .filter((j) => productionJobIsCompleted(j) && productionOutputDateISO(j) >= cutoff)
    .reduce((s, j) => s + productionJobActualMeters(j), 0);

  const millOutput7d = movements
    .filter((m) => m.type === 'FINISHED_GOODS' && toIsoDate(m.dateISO || m.atISO) >= cutoff)
    .reduce((s, m) => s + (Number(m.qty) || 0), 0);

  const activeWip = Object.values(wipByProduct || {}).filter((qty) => Number(qty) > 0).length;
  const pendingCoil = (coilRequests || []).filter((r) => String(r.status).toLowerCase() === 'pending').length;
  const activeJobs = activeWip + pendingCoil;

  return { metresProduced7d, millOutput7d, activeJobs };
}

export function liveReceivablesNgn(quotations = [], ledgerEntries = []) {
  return quotations.reduce(
    (s, q) => s + amountDueOnQuotationFromEntries(ledgerEntries, q),
    0
  );
}

export function filterQuotationsInRange(quotations = [], startDate, endDate) {
  return quotations.filter((q) => {
    const iso = toIsoDate(q.dateISO);
    return (!startDate || iso >= startDate) && (!endDate || iso <= endDate);
  });
}

/** Expenses in period by `date` on the expense row (accrual-style expense recognition date in app). */
export function filterExpensesInRange(expenses = [], startDate, endDate) {
  return expenses.filter((ex) => {
    const iso = toIsoDate(ex.date);
    return (!startDate || iso >= startDate) && (!endDate || iso <= endDate);
  });
}

/** Refunds with request date in range (`requestedAtISO`). */
export function filterRefundsInRange(refunds = [], startDate, endDate) {
  return refunds.filter((r) => {
    const iso = toIsoDate(r.requestedAtISO);
    return (!startDate || iso >= startDate) && (!endDate || iso <= endDate);
  });
}

/** Purchase orders whose `orderDateISO` falls in range (orders without a date are excluded). */
export function filterPurchaseOrdersInRange(purchaseOrders = [], startDate, endDate) {
  return purchaseOrders.filter((po) => {
    const iso = toIsoDate(po.orderDateISO);
    if (!iso) return false;
    return (!startDate || iso >= startDate) && (!endDate || iso <= endDate);
  });
}

/** Production accessory postings in range (`postedAtISO`). */
export function filterAccessoryUsageInRange(rows = [], startDate, endDate) {
  return rows.filter((u) => {
    const iso = toIsoDate(u.postedAtISO);
    if (!iso) return false;
    return (!startDate || iso >= startDate) && (!endDate || iso <= endDate);
  });
}

/**
 * Revenue attributed to production in the period (not cash): each completed job dated by production completion,
 * quotation total split by actual metres across all completed jobs for that quote.
 */
export function productionAttributedRevenueNgn(quotations = [], productionJobs = [], startDate, endDate) {
  const qById = new Map(quotations.map((q) => [String(q.id || '').trim(), q]));
  const metersByRef = metersProducedByQuotationRef(productionJobs);
  let sum = 0;
  for (const j of productionJobs) {
    if (!productionJobIsCompleted(j)) continue;
    const iso = productionOutputDateISO(j);
    if (!iso) continue;
    if (startDate && iso < startDate) continue;
    if (endDate && iso > endDate) continue;
    const ref = String(j.quotationRef || '').trim();
    if (!ref) continue;
    const q = qById.get(ref);
    sum += allocatedQuotationRevenueForProductionJob(j, q, metersByRef);
  }
  return Math.round(sum);
}

/** @deprecated Use {@link topCustomersByProductionAttributedSales} for “sales” ranking; this sums quotation totals by quote date (pipeline only). */
export function topCustomersBySales(quotations = [], startDate, endDate, limit = 5) {
  const inRange = filterQuotationsInRange(quotations, startDate, endDate);
  const byCustomer = new Map();
  inRange.forEach((q) => {
    const key = q.customerID || q.customer;
    const row = byCustomer.get(key) || { customer: q.customer, amountNgn: 0, quotations: 0 };
    row.amountNgn += Number(q.totalNgn) || 0;
    row.quotations += 1;
    byCustomer.set(key, row);
  });
  return [...byCustomer.values()].sort((a, b) => b.amountNgn - a.amountNgn).slice(0, limit);
}

/** Top customers by production-attributed sales (production completion date in range). */
export function topCustomersByProductionAttributedSales(
  quotations = [],
  productionJobs = [],
  startDate,
  endDate,
  limit = 5
) {
  const qById = new Map(quotations.map((q) => [String(q.id || '').trim(), q]));
  const metersByRef = metersProducedByQuotationRef(productionJobs);
  const byCustomer = new Map();
  for (const j of productionJobs) {
    if (!productionJobIsCompleted(j)) continue;
    const iso = productionOutputDateISO(j);
    if (!iso) continue;
    if (startDate && iso < startDate) continue;
    if (endDate && iso > endDate) continue;
    const ref = String(j.quotationRef || '').trim();
    const q = qById.get(ref);
    const alloc = allocatedQuotationRevenueForProductionJob(j, q, metersByRef);
    if (alloc <= 0) continue;
    const key = (q && (q.customerID || q.customer)) || j.customerID || j.customerName || ref;
    const display = (q && q.customer) || j.customerName || j.customerID || '—';
    const row = byCustomer.get(key) || { customer: display, amountNgn: 0, completedJobs: 0 };
    row.amountNgn += alloc;
    row.completedJobs += 1;
    byCustomer.set(key, row);
  }
  return [...byCustomer.values()]
    .map((r) => ({ ...r, amountNgn: Math.round(r.amountNgn) }))
    .sort((a, b) => b.amountNgn - a.amountNgn)
    .slice(0, limit);
}

export function receivablesAgingBuckets(quotations = [], ledgerEntries = [], asOfISO = new Date().toISOString().slice(0, 10)) {
  const buckets = { current: 0, days1to30: 0, days31to60: 0, days61to90: 0, days90plus: 0 };
  quotations.forEach((q) => {
    const due = amountDueOnQuotationFromEntries(ledgerEntries, q);
    if (due <= 0) return;
    const basis = toIsoDate(q.dueDateISO || q.dateISO);
    const basisDate = basis ? new Date(`${basis}T00:00:00`) : null;
    const asOfDate = new Date(`${toIsoDate(asOfISO)}T00:00:00`);
    if (!basisDate || Number.isNaN(basisDate.getTime()) || Number.isNaN(asOfDate.getTime())) {
      buckets.current += due;
      return;
    }
    const diffDays = Math.floor((asOfDate.getTime() - basisDate.getTime()) / 86400000);
    if (diffDays <= 0) buckets.current += due;
    else if (diffDays <= 30) buckets.days1to30 += due;
    else if (diffDays <= 60) buckets.days31to60 += due;
    else if (diffDays <= 90) buckets.days61to90 += due;
    else buckets.days90plus += due;
  });
  return buckets;
}

export function supplierPerformanceSummary(purchaseOrders = [], limit = 5) {
  const bySupplier = new Map();
  purchaseOrders.forEach((po) => {
    const key = po.supplierID || po.supplierName || 'Unknown';
    const row = bySupplier.get(key) || {
      supplierName: po.supplierName || 'Unknown',
      poCount: 0,
      orderValueNgn: 0,
      paidNgn: 0,
      receivedCount: 0,
    };
    const orderValue = (po.lines || []).reduce((sum, line) => sum + poLineOrderedValueNgn(line), 0);
    row.poCount += 1;
    row.orderValueNgn += orderValue;
    row.paidNgn += Number(po.supplierPaidNgn) || 0;
    if (po.status === 'Received') row.receivedCount += 1;
    bySupplier.set(key, row);
  });
  return [...bySupplier.values()]
    .map((row) => ({
      ...row,
      outstandingNgn: Math.max(0, row.orderValueNgn - row.paidNgn),
      receiveRatePct: row.poCount > 0 ? Math.round((row.receivedCount / row.poCount) * 100) : 0,
    }))
    .sort((a, b) => b.orderValueNgn - a.orderValueNgn)
    .slice(0, limit);
}

export function deliveryPerformanceSummary(deliveries = []) {
  return deliveries.reduce(
    (acc, row) => {
      acc.total += 1;
      if (row.status === 'Delivered') acc.delivered += 1;
      else if (row.status === 'In transit') acc.inTransit += 1;
      else if (row.status === 'Exception') acc.exceptions += 1;
      acc.totalLines += Number(row.lineCount) || 0;
      return acc;
    },
    { total: 0, delivered: 0, inTransit: 0, exceptions: 0, totalLines: 0 }
  );
}

/** Ledger lines with `atISO` date (YYYY-MM-DD or full ISO) within [startDate, endDate]. */
export function filterLedgerEntriesInRange(ledgerEntries = [], startDate, endDate) {
  return (ledgerEntries || []).filter((e) => {
    const iso = toIsoDate(e.atISO);
    return (!startDate || iso >= startDate) && (!endDate || iso <= endDate);
  });
}

/**
 * Rows for customer ledger / receipts report (export + print).
 * @param {Array} quotations - for customer name fallback by quotation id
 */
export function customerLedgerActivityRows(ledgerEntries = [], quotations = [], startDate, endDate) {
  const inRange = filterLedgerEntriesInRange(ledgerEntries, startDate, endDate);
  const quoteCustomer = new Map(
    (quotations || []).map((q) => [String(q.id || '').trim(), q.customer || q.customerName || ''])
  );
  return [...inRange].sort((a, b) => String(a.atISO).localeCompare(String(b.atISO))).map((e) => {
    const qref = String(e.quotationRef || '').trim();
    return {
      atISO: e.atISO,
      type: e.type,
      customerID: e.customerID,
      customerName: e.customerName || '',
      quotationRef: qref,
      quotationCustomer: qref ? quoteCustomer.get(qref) || '' : '',
      amountNgn: e.amountNgn,
      paymentMethod: e.paymentMethod || '',
      bankReference: e.bankReference || '',
      purpose: e.purpose || '',
      note: e.note || '',
      branchId: e.branchId || '',
    };
  });
}

/**
 * True if the quotation has at least one **completed** production job whose completion date is on or before `endDateISO`.
 * Used to tag receipts in a period vs production timing (e.g. paid 31 Jan, produced 1 Feb → Jan report = not produced).
 */
export function quotationHasCompletedProductionByEndDate(quotationRef, productionJobs, endDateISO) {
  const ref = String(quotationRef || '').trim();
  if (!ref) return false;
  const end = toIsoDate(endDateISO);
  for (const j of productionJobs || []) {
    if (String(j.status || '').trim() !== 'Completed') continue;
    if (String(j.quotationRef || '').trim() !== ref) continue;
    const d = productionOutputDateISO(j);
    if (!d) continue;
    if (!end || d <= end) return true;
  }
  return false;
}

/**
 * Flat rows for export/print: customer cash in the period (receipts + advances) by production status as of period end;
 * ledger reversals in period; refund payouts dated in period; refunds pending or awaiting payout; open receivables (live);
 * production jobs completed in the period (bridge to revenue timing).
 */
export function salesPeriodCashBridgeExportRows(
  ledgerEntries = [],
  productionJobs = [],
  quotations = [],
  refunds = [],
  startDate,
  endDate
) {
  const rows = [];
  const inRange = filterLedgerEntriesInRange(ledgerEntries, startDate, endDate);
  const quoteCustomer = new Map(
    (quotations || []).map((q) => [String(q.id || '').trim(), q.customer || q.customerName || ''])
  );

  const inflowTypes = new Set(['RECEIPT', 'ADVANCE_IN', 'OVERPAY_ADVANCE']);
  const reversalTypes = new Set(['RECEIPT_REVERSAL', 'ADVANCE_REVERSAL']);

  for (const e of [...inRange].sort((a, b) => String(a.atISO).localeCompare(String(b.atISO)))) {
    const type = String(e.type || '');
    if (inflowTypes.has(type)) {
      const qref = String(e.quotationRef || '').trim();
      let category = '';
      if (type === 'RECEIPT') {
        if (!qref) category = 'Receipt — no quotation on line';
        else if (quotationHasCompletedProductionByEndDate(qref, productionJobs, endDate))
          category = 'Receipt on quote — production completed by period end';
        else category = 'Receipt on quote — not produced by period end';
      } else {
        category = 'Advance / overpay received (deposit)';
      }
      rows.push({
        reportSection: 'Customer cash in (period)',
        category,
        ledgerType: type,
        dateISO: toIsoDate(e.atISO),
        recordId: e.id,
        customer: e.customerName || e.customerID || '',
        quotationRef: qref,
        quoteCustomer: qref ? quoteCustomer.get(qref) || '' : '',
        amountNgn: Math.round(Number(e.amountNgn) || 0),
        metresProduced: '',
        remarks: [e.paymentMethod, e.bankReference].filter(Boolean).join(' · '),
      });
    } else if (reversalTypes.has(type)) {
      rows.push({
        reportSection: 'Reversals (period)',
        category: type === 'RECEIPT_REVERSAL' ? 'Receipt reversal' : 'Advance reversal',
        ledgerType: type,
        dateISO: toIsoDate(e.atISO),
        recordId: e.id,
        customer: e.customerName || e.customerID || '',
        quotationRef: String(e.quotationRef || '').trim(),
        quoteCustomer: '',
        amountNgn: Math.round(Number(e.amountNgn) || 0),
        metresProduced: '',
        remarks: e.bankReference || e.note || '',
      });
    }
  }

  for (const r of refunds || []) {
    const hist = Array.isArray(r.payoutHistory) ? r.payoutHistory : [];
    if (hist.length > 0) {
      for (const p of hist) {
        const iso = toIsoDate(p.postedAtISO);
        if (!iso) continue;
        if (startDate && iso < startDate) continue;
        if (endDate && iso > endDate) continue;
        const amt = Math.round(Number(p.amountNgn) || 0);
        if (amt <= 0) continue;
        rows.push({
          reportSection: 'Refund payouts (period)',
          category: 'Refund cash paid',
          ledgerType: 'REFUND_PAYOUT',
          dateISO: iso,
          recordId: p.id || r.refundID,
          customer: r.customer || '',
          quotationRef: r.quotationRef || '',
          quoteCustomer: '',
          amountNgn: amt,
          metresProduced: '',
          remarks: r.refundID || '',
        });
      }
    } else {
      const paidIso = toIsoDate(r.paidAtISO);
      const paidAmt = Math.round(Number(r.paidAmountNgn) || 0);
      if (paidAmt > 0 && paidIso && (!startDate || paidIso >= startDate) && (!endDate || paidIso <= endDate)) {
        rows.push({
          reportSection: 'Refund payouts (period)',
          category: 'Refund cash paid (single paid date)',
          ledgerType: 'REFUND_PAYOUT',
          dateISO: paidIso,
          recordId: r.refundID,
          customer: r.customer || '',
          quotationRef: r.quotationRef || '',
          quoteCustomer: '',
          amountNgn: paidAmt,
          metresProduced: '',
          remarks: r.refundID || '',
        });
      }
    }
  }

  for (const r of refunds || []) {
    const st = String(r.status || '');
    if (st === 'Rejected') continue;
    if (st === 'Pending') {
      const req = Math.round(Number(r.amountNgn) || 0);
      if (req <= 0) continue;
      rows.push({
        reportSection: 'Refunds pending approval',
        category: 'Request not yet approved',
        ledgerType: 'REFUND_OPEN',
        dateISO: toIsoDate(r.requestedAtISO) || '',
        recordId: r.refundID,
        customer: r.customer || '',
        quotationRef: r.quotationRef || '',
        quoteCustomer: '',
        amountNgn: req,
        metresProduced: '',
        remarks: `Status: ${st}`,
      });
      continue;
    }
    const out = refundOutstandingAmount(r);
    if (out <= 0) continue;
    if (st === 'Approved' || st === 'Paid') {
      rows.push({
        reportSection: 'Refunds awaiting payout',
        category: 'Approved — balance not yet paid',
        ledgerType: 'REFUND_OPEN',
        dateISO: toIsoDate(r.requestedAtISO) || '',
        recordId: r.refundID,
        customer: r.customer || '',
        quotationRef: r.quotationRef || '',
        quoteCustomer: '',
        amountNgn: out,
        metresProduced: '',
        remarks: `Status: ${st}`,
      });
    }
  }

  for (const q of quotations || []) {
    const due = amountDueOnQuotationFromEntries(ledgerEntries, q);
    if (due <= 0) continue;
    rows.push({
      reportSection: 'Open receivables (live snapshot)',
      category: 'Amount still due on quotation',
      ledgerType: 'AR_OPEN',
      dateISO: endDate || '',
      recordId: q.id,
      customer: q.customer || q.customerName || '',
      quotationRef: q.id,
      quoteCustomer: '',
      amountNgn: due,
      metresProduced: '',
      remarks: `Quote total ₦${Math.round(Number(q.totalNgn) || 0)} · paid ₦${Math.round(Number(q.paidNgn) || 0)}`,
    });
  }

  for (const j of productionJobs || []) {
    if (String(j.status || '').trim() !== 'Completed') continue;
    const iso = productionOutputDateISO(j);
    if (!iso) continue;
    if (startDate && iso < startDate) continue;
    if (endDate && iso > endDate) continue;
    const ref = String(j.quotationRef || '').trim();
    const m = productionJobActualMeters(j);
    rows.push({
      reportSection: 'Production completed (period)',
      category: 'Job completed (revenue timing bridge)',
      ledgerType: 'PRODUCTION',
      dateISO: iso,
      recordId: j.jobID || j.id || '',
      customer: j.customerName || j.customerID || '',
      quotationRef: ref,
      quoteCustomer: ref ? quoteCustomer.get(ref) || '' : '',
      amountNgn: 0,
      metresProduced: m,
      remarks: j.productName || j.productID || '',
    });
  }

  return rows;
}

/** Summary numbers for print header lines (same inputs as {@link salesPeriodCashBridgeExportRows}). */
export function salesPeriodCashBridgeSummary(
  ledgerEntries,
  productionJobs,
  quotations,
  refunds,
  startDate,
  endDate
) {
  const flat = salesPeriodCashBridgeExportRows(
    ledgerEntries,
    productionJobs,
    quotations,
    refunds,
    startDate,
    endDate
  );
  const sumSection = (section, pred = () => true) =>
    flat
      .filter((r) => r.reportSection === section && pred(r))
      .reduce((s, r) => s + (Number(r.amountNgn) || 0), 0);
  const countSection = (section, pred = () => true) => flat.filter((r) => r.reportSection === section && pred(r)).length;

  return {
    cashInReceiptProducedNgn: sumSection('Customer cash in (period)', (r) =>
      String(r.category || '').includes('production completed')
    ),
    cashInReceiptNotProducedNgn: sumSection('Customer cash in (period)', (r) =>
      String(r.category || '').includes('not produced')
    ),
    cashInReceiptNoQuoteNgn: sumSection('Customer cash in (period)', (r) => String(r.category || '').includes('no quotation')),
    cashInAdvanceNgn: sumSection('Customer cash in (period)', (r) => String(r.category || '').includes('Advance / overpay')),
    reversalsNgn: sumSection('Reversals (period)'),
    refundPayoutsNgn: sumSection('Refund payouts (period)'),
    refundAwaitingNgn: sumSection('Refunds awaiting payout'),
    refundPendingApprovalNgn: sumSection('Refunds pending approval'),
    receivablesOpenNgn: sumSection('Open receivables (live snapshot)'),
    receivablesOpenQuotes: countSection('Open receivables (live snapshot)'),
    productionJobsCompleted: countSection('Production completed (period)'),
    rowCount: flat.length,
  };
}

export function filterBankReconciliationInRange(bankReconciliation = [], startDate, endDate) {
  return (bankReconciliation || []).filter((row) => {
    const iso = toIsoDate(row.bankDateISO);
    return (!startDate || iso >= startDate) && (!endDate || iso <= endDate);
  });
}

export function filterTreasuryMovementsInRange(treasuryMovements = [], startDate, endDate) {
  return (treasuryMovements || []).filter((m) => {
    const iso = toIsoDate(m.postedAtISO);
    return (!startDate || iso >= startDate) && (!endDate || iso <= endDate);
  });
}

/** Net treasury amount (₦) for movements tied to a ledger source (includes reversals). */
export function netTreasuryAmountForLedgerSource(treasuryMovements = [], sourceKind, sourceId) {
  const sid = String(sourceId || '').trim();
  const sk = String(sourceKind || '').trim();
  if (!sid || !sk) return 0;
  return Math.round(
    (treasuryMovements || [])
      .filter((m) => m.sourceKind === sk && m.sourceId === sid)
      .reduce((s, m) => s + (Number(m.amountNgn) || 0), 0)
  );
}

/**
 * RECEIPT ledger lines in period whose net treasury (LEDGER_RECEIPT) does not match amount.
 * Policy: if you post cash, treasury split should equal receipt amount (±tol).
 */
export function ledgerReceiptsTreasuryMismatches(
  ledgerEntries = [],
  treasuryMovements = [],
  startDate,
  endDate,
  tolNgn = 1
) {
  const inRange = filterLedgerEntriesInRange(ledgerEntries, startDate, endDate);
  const rows = [];
  for (const e of inRange) {
    if (e.type !== 'RECEIPT') continue;
    const expected = Math.round(Math.abs(Number(e.amountNgn) || 0));
    if (expected <= 0) continue;
    const net = netTreasuryAmountForLedgerSource(treasuryMovements, 'LEDGER_RECEIPT', e.id);
    if (Math.abs(net - expected) > tolNgn) {
      rows.push({
        section: 'receipt',
        ledgerEntryId: e.id,
        atISO: e.atISO,
        customerName: e.customerName || '',
        quotationRef: e.quotationRef || '',
        ledgerAmountNgn: expected,
        treasuryNetNgn: net,
        deltaNgn: expected - net,
        issue:
          net === 0
            ? 'No treasury movement (or net zero) for this receipt id'
            : 'Treasury net does not match receipt amount',
      });
    }
  }
  return rows;
}

/** ADVANCE_IN / OVERPAY_ADVANCE in period vs treasury source LEDGER_ADVANCE. */
export function ledgerAdvancesTreasuryMismatches(
  ledgerEntries = [],
  treasuryMovements = [],
  startDate,
  endDate,
  tolNgn = 1
) {
  const inRange = filterLedgerEntriesInRange(ledgerEntries, startDate, endDate);
  const rows = [];
  for (const e of inRange) {
    if (e.type !== 'ADVANCE_IN' && e.type !== 'OVERPAY_ADVANCE') continue;
    const expected = Math.round(Math.abs(Number(e.amountNgn) || 0));
    if (expected <= 0) continue;
    const net = netTreasuryAmountForLedgerSource(treasuryMovements, 'LEDGER_ADVANCE', e.id);
    if (Math.abs(net - expected) > tolNgn) {
      rows.push({
        section: 'advance',
        ledgerEntryId: e.id,
        atISO: e.atISO,
        type: e.type,
        customerName: e.customerName || '',
        ledgerAmountNgn: expected,
        treasuryNetNgn: net,
        deltaNgn: expected - net,
        issue:
          net === 0
            ? 'No treasury movement for this advance id'
            : 'Treasury net does not match advance amount',
      });
    }
  }
  return rows;
}

/** RECEIPT_IN lines in period referencing a ledger id that is not a RECEIPT row. */
export function treasuryReceiptInsOrphanLedger(treasuryMovements = [], ledgerEntries = [], startDate, endDate) {
  const byId = new Map((ledgerEntries || []).map((e) => [e.id, e]));
  const rows = [];
  for (const m of filterTreasuryMovementsInRange(treasuryMovements, startDate, endDate)) {
    if (m.type !== 'RECEIPT_IN' || m.sourceKind !== 'LEDGER_RECEIPT' || !m.sourceId) continue;
    const le = byId.get(m.sourceId);
    if (!le || le.type !== 'RECEIPT') {
      rows.push({
        section: 'orphan_treasury',
        treasuryMovementId: m.id,
        postedAtISO: m.postedAtISO,
        sourceId: m.sourceId,
        amountNgn: m.amountNgn,
        issue: 'No RECEIPT ledger entry with this id',
      });
    }
  }
  return rows;
}

export function receiptAdvanceTreasuryReconciliationRows(
  ledgerEntries,
  treasuryMovements,
  startDate,
  endDate
) {
  return [
    ...ledgerReceiptsTreasuryMismatches(ledgerEntries, treasuryMovements, startDate, endDate),
    ...ledgerAdvancesTreasuryMismatches(ledgerEntries, treasuryMovements, startDate, endDate),
    ...treasuryReceiptInsOrphanLedger(treasuryMovements, ledgerEntries, startDate, endDate),
  ];
}

function sumReceiptsNgnForQuotation(salesReceipts, quotationId) {
  const id = String(quotationId || '').trim();
  if (!id) return 0;
  let s = 0;
  for (const r of salesReceipts || []) {
    const ref = String(r.quotationRef ?? r.quotation_ref ?? '').trim();
    if (ref !== id) continue;
    const st = String(r.status || '').trim().toLowerCase();
    if (st === 'reversed') continue;
    s += Number(r.amountNgn ?? r.amount_ngn) || 0;
  }
  return Math.round(s);
}

function sumAdvanceAppliedNgnForQuotation(ledgerEntries, quotationId) {
  const id = String(quotationId || '').trim();
  if (!id) return 0;
  let s = 0;
  for (const e of ledgerEntries || []) {
    if (e.type !== 'ADVANCE_APPLIED') continue;
    const ref = String(e.quotationRef || '').trim();
    if (ref !== id) continue;
    s += Number(e.amountNgn) || 0;
  }
  return Math.round(s);
}

/**
 * Quotations where `paidNgn` ≠ sum of **sales receipts** for that quote + `ADVANCE_APPLIED` on the ledger
 * (matches server `syncQuotationPaidFromReceipts`).
 */
export function quotationPaidNgnReceiptDiscrepancies(
  quotations = [],
  salesReceipts = [],
  ledgerEntries = [],
  toleranceNgn = 1
) {
  return (quotations || [])
    .map((q) => {
      const stored = Math.round(Number(q.paidNgn ?? q.paid_ngn) || 0);
      const receiptSum = sumReceiptsNgnForQuotation(salesReceipts, q.id);
      const advanceApplied = sumAdvanceAppliedNgnForQuotation(ledgerEntries, q.id);
      const expected = receiptSum + advanceApplied;
      const delta = stored - expected;
      return {
        quotationID: q.id,
        dateISO: q.dateISO,
        customer: q.customer,
        totalNgn: q.totalNgn,
        paidNgnOnQuote: stored,
        receiptPaidNgn: receiptSum,
        advanceAppliedNgn: advanceApplied,
        expectedPaidNgn: expected,
        deltaNgn: delta,
      };
    })
    .filter((row) => Math.abs(row.deltaNgn) > toleranceNgn);
}

export function filterCoilLotsReceivedInRange(coilLots = [], startDate, endDate) {
  return (coilLots || []).filter((lot) => {
    const iso = toIsoDate(lot.receivedAtISO);
    return (!startDate || iso >= startDate) && (!endDate || iso <= endDate);
  });
}

export function grnCoilRegisterRows(coilLots = [], startDate, endDate) {
  return filterCoilLotsReceivedInRange(coilLots, startDate, endDate)
    .slice()
    .sort((a, b) => String(a.receivedAtISO).localeCompare(String(b.receivedAtISO)))
    .map((lot) => ({
      receivedAtISO: lot.receivedAtISO,
      coilNo: lot.coilNo,
      poID: lot.poID || '',
      supplierName: lot.supplierName || '',
      productID: lot.productID,
      lineKey: lot.lineKey || '',
      qtyReceived: lot.qtyReceived,
      weightKg: lot.weightKg ?? '',
      landedCostNgn: lot.landedCostNgn ?? '',
      unitCostNgnPerKg: lot.unitCostNgnPerKg ?? '',
      currentStatus: lot.currentStatus,
      branchId: lot.branchId || '',
    }));
}

/** Ordered line value: per-unit `unitPriceNgn` or, when that is zero, `qty × unitPricePerKgNgn` (coil kg lines). */
export function poLineOrderedValueNgn(line) {
  const q = Number(line.qtyOrdered) || 0;
  const up = Math.round(Number(line.unitPriceNgn) || 0);
  const upkg = Math.round(Number(line.unitPricePerKgNgn) || 0);
  if (up > 0) return Math.round(q * up);
  if (upkg > 0) return Math.round(q * upkg);
  return 0;
}

/** Sum of ordered line values for a PO (same rules as {@link poLineOrderedValueNgn}). */
export function purchaseOrderOrderedValueNgn(po) {
  return (po?.lines || []).reduce((s, l) => s + poLineOrderedValueNgn(l), 0);
}

function poLineReceivedValueNgn(line) {
  const q = Number(line.qtyReceived) || 0;
  const up = Math.round(Number(line.unitPriceNgn) || 0);
  const upkg = Math.round(Number(line.unitPricePerKgNgn) || 0);
  if (up > 0) return Math.round(q * up);
  if (upkg > 0) return Math.round(q * upkg);
  return 0;
}

/** One row per PO: ordered value, received value (qty received × price), supplier paid. */
export function purchaseOrderAccrualBridgeRows(purchaseOrders = []) {
  return (purchaseOrders || []).map((po) => {
    const lines = po.lines || [];
    const orderedValueNgn = lines.reduce((s, l) => s + poLineOrderedValueNgn(l), 0);
    const receivedValueNgn = lines.reduce((s, l) => s + poLineReceivedValueNgn(l), 0);
    const paidNgn = Math.round(Number(po.supplierPaidNgn) || 0);
    return {
      poID: po.poID,
      supplierName: po.supplierName,
      orderDateISO: po.orderDateISO,
      status: po.status,
      orderedValueNgn,
      receivedValueNgn,
      supplierPaidNgn: paidNgn,
      receivedMinusPaidNgn: receivedValueNgn - paidNgn,
      branchId: po.branchId || '',
    };
  });
}

/** Coil lots still holding quantity — inventory value using stored cost fields when present. */
export function coilInventoryValuationRows(coilLots = []) {
  return (coilLots || [])
    .filter((lot) => (Number(lot.qtyRemaining) || 0) > 0.0001 || (Number(lot.currentWeightKg) || 0) > 0.0001)
    .map((lot) => {
      const kg = Number(lot.currentWeightKg) || Number(lot.qtyRemaining) || 0;
      const unit = Math.round(Number(lot.unitCostNgnPerKg) || 0);
      const valueNgn =
        unit > 0 && kg > 0
          ? Math.round(kg * unit)
          : lot.landedCostNgn != null && Number(lot.landedCostNgn) > 0
            ? Math.round(Number(lot.landedCostNgn))
            : '';
      return {
        coilNo: lot.coilNo,
        productID: lot.productID,
        poID: lot.poID || '',
        kgOnHand: kg,
        unitCostNgnPerKg: unit || '',
        extendedValueNgn: valueNgn,
        currentStatus: lot.currentStatus,
        branchId: lot.branchId || '',
      };
    });
}

/** Stock movements in period with optional COGS value (e.g. COIL_CONSUMPTION). */
export function filterStockMovementsInRange(movements = [], startDate, endDate) {
  return (movements || []).filter((m) => {
    const iso = toIsoDate(m.atISO || m.dateISO);
    if (!iso) return false;
    return (!startDate || iso >= startDate) && (!endDate || iso <= endDate);
  });
}

export function cogsMovementRows(movements = [], startDate, endDate) {
  return filterStockMovementsInRange(movements, startDate, endDate)
    .filter((m) => String(m.type || '').includes('CONSUMPTION') || Number(m.valueNgn) > 0)
    .map((m) => ({
      dateISO: toIsoDate(m.dateISO || m.atISO),
      atISO: m.atISO,
      type: m.type,
      ref: m.ref || '',
      productID: m.productID || '',
      qty: m.qty,
      unitPriceNgn: m.unitPriceNgn ?? '',
      valueNgn: m.valueNgn ?? '',
      detail: m.detail || '',
    }));
}

/** Approved payment requests with unpaid balance (accrual helper). */
export function accruedApprovedPayablesRows(paymentRequests = [], startDate, endDate) {
  return (paymentRequests || [])
    .filter((pr) => {
      if (String(pr.approvalStatus) !== 'Approved') return false;
      const requested = Math.round(Number(pr.amountRequestedNgn) || 0);
      const paid = Math.round(Number(pr.paidAmountNgn) || 0);
      if (requested - paid <= 0) return false;
      const iso = toIsoDate(pr.approvedAtISO || pr.requestDate);
      return (!startDate || iso >= startDate) && (!endDate || iso <= endDate);
    })
    .map((pr) => {
      const requested = Math.round(Number(pr.amountRequestedNgn) || 0);
      const paid = Math.round(Number(pr.paidAmountNgn) || 0);
      return {
        requestID: pr.requestID,
        approvedAtISO: pr.approvedAtISO || '',
        requestDate: pr.requestDate,
        description: pr.description || '',
        expenseID: pr.expenseID || '',
        expenseCategory: pr.expenseCategory || '',
        amountRequestedNgn: requested,
        paidAmountNgn: paid,
        accruedUnpaidNgn: requested - paid,
        branchId: pr.branchId || '',
      };
    });
}

export function openAuditQueue(bankReconciliation = [], paymentRequests = [], refunds = []) {
  const items = [];
  bankReconciliation
    .filter((x) => x.status === 'Review' || x.status === 'PendingManager')
    .forEach((x) => {
      items.push({
        id: x.id,
        customer: x.description,
        amount: Math.abs(Number(x.amountNgn) || 0),
        bank: x.status === 'PendingManager' ? 'Awaiting manager (bank recon)' : 'Bank statement',
        date: x.bankDateISO,
        desc:
          x.status === 'PendingManager'
            ? `Variance clearance · ${x.systemMatch || '—'}`
            : x.systemMatch || 'Unmatched statement line',
      });
    });
  paymentRequests
    .filter((x) => {
      const requested = Number(x.amountRequestedNgn) || 0;
      const paid = Number(x.paidAmountNgn) || 0;
      if (x.approvalStatus === 'Rejected') return false;
      if (x.approvalStatus !== 'Approved') return true;
      return paid < requested;
    })
    .forEach((x) => {
      const requested = Number(x.amountRequestedNgn) || 0;
      const paid = Number(x.paidAmountNgn) || 0;
      items.push({
        id: x.requestID,
        customer: x.description || 'Payment request',
        amount: Math.max(0, requested - paid),
        bank: x.approvalStatus === 'Approved' ? 'Treasury queue' : 'Approval queue',
        date: x.requestDate,
        desc: x.approvalStatus === 'Approved' ? x.expenseID || 'Awaiting payout' : x.expenseID || 'Awaiting approval',
      });
    });
  refunds
    .filter((x) => x.status === 'Approved' && refundOutstandingAmount(x) > 0)
    .forEach((x) => {
      items.push({
        id: x.refundID,
        customer: x.customer,
        amount: refundOutstandingAmount(x),
        bank: 'Refund queue',
        date: x.approvalDate || x.requestedAtISO?.slice(0, 10) || '',
        desc: x.reason || 'Approved refund awaiting payment',
      });
    });
  return items.slice(0, 12);
}

export { productionTransactionReportRows } from './productionTransactionReportCore.js';

