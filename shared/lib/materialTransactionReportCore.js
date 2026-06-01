/**
 * Material transaction register — production + other stock movements in period.
 * Grouped: aluminium / aluzinc (by gauge, coil sort), stone-coated, accessories,
 * cancelled jobs, other movements.
 */

import { displayCoilNumber, displayDocNumber } from './reportDisplayFormat.js';
import {
  allocatedQuotationRevenueForProductionJob,
  metersProducedByQuotationRef,
  productionOutputDateISO,
} from './liveAnalytics.js';
const ACCESSORY_REGISTER_TYPES = [
  { key: 'nails_fasteners', label: 'Nails & fasteners', patterns: [/nail/i, /fastener/i, /tapping screw/i] },
  { key: 'screws_clips', label: 'Screws & clips', patterns: [/screw/i, /clip/i, /washer/i] },
  { key: 'ridge_cap', label: 'Ridge & cap', patterns: [/ridge/i, /\bcap\b/i, /capping/i] },
  { key: 'flashing_trim', label: 'Flashing & trim', patterns: [/flash/i, /trim/i, /barge/i, /fascia/i, /gutter/i] },
  { key: 'sealants', label: 'Sealants & adhesives', patterns: [/silicone/i, /sealant/i, /adhesive/i, /glue/i] },
  { key: 'underlay', label: 'Underlay / membrane', patterns: [/underlay/i, /membrane/i, /felt/i] },
  { key: 'stone_accessories', label: 'Stone-coated accessories', patterns: [/stone nail/i, /stone-coated acc/i] },
  { key: 'other', label: 'Other', patterns: [] },
];

function normKey(s) {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function coilMaterialFamily(materialTypeName) {
  const k = normKey(materialTypeName);
  if (!k) return null;
  if (k.includes('aluzinc')) return 'aluzinc';
  if (k.includes('aluminium') || k.includes('aluminum') || k === 'alu') return 'aluminium';
  return null;
}

function accessoryRegisterTypeKey(productName) {
  const name = String(productName || '');
  for (const t of ACCESSORY_REGISTER_TYPES) {
    if (t.key === 'other') continue;
    if (t.patterns.some((p) => p.test(name))) return t.key;
  }
  return 'other';
}

function accessoryRegisterTypeLabel(key) {
  return ACCESSORY_REGISTER_TYPES.find((t) => t.key === key)?.label || 'Other';
}

function toIsoDate(value) {
  return String(value || '').slice(0, 10);
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function gaugeSortKey(gaugeLabel) {
  const m = String(gaugeLabel || '').match(/(\d+(?:\.\d+)?)/);
  return m ? Number(m[1]) : 999;
}

function refundsPaidOnQuotationNgn(refunds, quotationRef) {
  const q = String(quotationRef || '').trim();
  if (!q) return 0;
  let sum = 0;
  for (const r of refunds || []) {
    const qr = String(r.quotationRef ?? r.quotation_ref ?? '').trim();
    if (qr !== q) continue;
    const st = String(r.status || '').trim().toLowerCase();
    if (st === 'rejected' || st === 'cancelled') continue;
    sum += Math.round(Number(r.paidAmountNgn ?? r.paid_amount_ngn) || 0);
  }
  return sum;
}

function quotationRowPaidNgn(q) {
  if (!q) return 0;
  return Math.round(Number(q.paidNgn ?? q.paid_ngn) || 0);
}

/** Paid on quote minus refunds paid (once per job). */
function amountPaidNetForJob(quote, refunds, qref) {
  const paid = quotationRowPaidNgn(quote);
  const refund = refundsPaidOnQuotationNgn(refunds, qref);
  return Math.max(0, paid - refund);
}

const PRODUCTION_MOVEMENT_TYPES = new Set([
  'COIL_CONSUMPTION',
  'STONE_CONSUMPTION',
  'ACCESSORY_ISSUE',
  'FINISHED_GOODS_RECEIPT',
  'PRODUCTION_FG_ADJUSTMENT',
  'ACCESSORY_ISSUE_ADJUSTMENT',
  'STONE_FLATSHEET_ISSUE_ADJUSTMENT',
]);

function normalizeJobRow(j) {
  if (!j) return j;
  return {
    ...j,
    jobID: j.jobID ?? j.job_id,
    quotationRef: j.quotationRef ?? j.quotation_ref,
    customerName: j.customerName ?? j.customer_name,
    productName: j.productName ?? j.product_name,
    status: j.status,
    completedAtISO: j.completedAtISO ?? j.completed_at_iso,
    endDateISO: j.endDateISO ?? j.end_date_iso,
    startDateISO: j.startDateISO ?? j.start_date_iso,
    actualMeters: j.actualMeters ?? j.actual_meters,
    effectiveOutputMeters: j.effectiveOutputMeters,
    actualWeightKg: j.actualWeightKg ?? j.actual_weight_kg,
  };
}

function normalizeCoilRow(c) {
  if (!c) return c;
  return {
    ...c,
    jobID: c.jobID ?? c.job_id,
    sequenceNo: c.sequenceNo ?? c.sequence_no,
    coilNo: c.coilNo ?? c.coil_no,
    colour: c.colour ?? c.color,
    gaugeLabel: c.gaugeLabel ?? c.gauge_label,
    openingWeightKg: c.openingWeightKg ?? c.opening_weight_kg,
    closingWeightKg: c.closingWeightKg ?? c.closing_weight_kg,
    consumedWeightKg: c.consumedWeightKg ?? c.consumed_weight_kg,
    metersProduced: c.metersProduced ?? c.meters_produced,
    actualConversionKgPerM: c.actualConversionKgPerM ?? c.actual_conversion_kg_per_m,
  };
}

function jobTxnDateISO(job) {
  return productionOutputDateISO(job) || toIsoDate(job?.startDateISO) || '';
}

function jobInPeriod(job, startDate, endDate) {
  const iso = jobTxnDateISO(job);
  if (!iso) return false;
  return (!startDate || iso >= startDate) && (!endDate || iso <= endDate);
}

function isCompleted(job) {
  return String(job?.status || '').trim() === 'Completed';
}

function isCancelled(job) {
  return String(job?.status || '').trim() === 'Cancelled';
}

function customerProjectLabel(job, quote) {
  const cust = String(job?.customerName || quote?.customerName || '').trim() || '—';
  const proj = String(quote?.projectName || quote?.project_name || '').trim();
  return proj ? `${cust} · ${proj}` : cust;
}

function summarizeCoilRows(rows) {
  let totalKg = 0;
  let totalM = 0;
  let totalOffcut = 0;
  const jobsPaid = new Set();
  let totalPaidNet = 0;
  for (const r of rows) {
    totalKg += Number(r.kgUsed) || 0;
    totalM += Number(r.meters) || 0;
    if (r.offcutKg != null) totalOffcut += Number(r.offcutKg) || 0;
    if (r.amountNetNgn != null && r.jobId && !jobsPaid.has(r.jobId)) {
      jobsPaid.add(r.jobId);
      totalPaidNet += Number(r.amountNetNgn) || 0;
    }
  }
  const weightedConversion = totalM > 0 ? round2(totalKg / totalM) : null;
  return {
    lineCount: rows.length,
    totalKgUsed: round2(totalKg),
    totalMeters: round2(totalM),
    weightedConversionKgM: weightedConversion,
    totalOffcutKg: round2(totalOffcut),
    totalPaidNetNgn: totalPaidNet,
  };
}

function groupCoilRowsByGauge(rows) {
  const byGauge = new Map();
  for (const r of rows) {
    const g = r.gauge || '—';
    if (!byGauge.has(g)) byGauge.set(g, []);
    byGauge.get(g).push(r);
  }
  const groups = [...byGauge.entries()]
    .sort((a, b) => gaugeSortKey(a[0]) - gaugeSortKey(b[0]) || String(a[0]).localeCompare(String(b[0])))
    .map(([gaugeLabel, gaugeRows]) => {
      gaugeRows.sort((a, b) => {
        const c = String(a.coilNo || '').localeCompare(String(b.coilNo || ''), undefined, { numeric: true });
        if (c !== 0) return c;
        return String(a.txnDate || '').localeCompare(String(b.txnDate || ''));
      });
      return { gaugeLabel, rows: gaugeRows, subtotals: summarizeCoilRows(gaugeRows) };
    });
  return { groups, totals: summarizeCoilRows(rows) };
}

function classifyProductCategory(product) {
  if (!product) return 'other';
  const pid = String(product.productID || product.product_id || '').trim();
  if (pid === 'COIL-ALU') return 'aluminium';
  if (pid === 'PRD-102') return 'aluzinc';
  const unit = String(product.unit || '').toLowerCase();
  const name = String(product.name || '');
  const mat = String(product.dashboardAttrs?.materialType || product.material_type || '');
  if (unit === 'm' || /stone/i.test(name) || /stone/i.test(mat)) return 'stoneCoated';
  if (/^acc/i.test(pid) || /accessory/i.test(name)) return 'accessories';
  const accKey = accessoryRegisterTypeKey(name);
  if (accKey && accKey !== 'other') return 'accessories';
  return 'other';
}

function buildCoilTxnRow({
  job,
  quote,
  coilRow,
  coilLot,
  isFirstCoil,
  metersByRef,
  refunds,
  cancelled,
}) {
  const qref = String(job.quotationRef || '').trim();
  const opening = Number(coilRow?.openingWeightKg) || 0;
  const closing = Number(coilRow?.closingWeightKg) || 0;
  const consumed = Number(coilRow?.consumedWeightKg) || 0;
  const drift = opening - consumed - closing;
  const offcut =
    Number.isFinite(drift) && Math.abs(drift) >= 0.05 ? round2(drift) : null;
  const cNo = String(coilRow?.coilNo || '').trim();
  const materialType = String(coilLot?.materialTypeName || '').trim() || '—';
  const gaugeLabel = String(coilRow?.gaugeLabel || '').trim() || '—';
  const conv = coilRow?.actualConversionKgPerM;
  const convRaw = conv != null && Number.isFinite(Number(conv)) ? Number(conv) : null;
  const convNum = convRaw != null && convRaw > 0 ? round2(convRaw) : null;
  const attributed = isFirstCoil
    ? Math.round(allocatedQuotationRevenueForProductionJob(job, quote, metersByRef))
    : null;
  const paidNet = isFirstCoil ? amountPaidNetForJob(quote, refunds, qref) : null;

  return {
    txnDate: jobTxnDateISO(job),
    qtNoDisplay: displayDocNumber(qref) || '—',
    customerProject: customerProjectLabel(job, quote),
    colour: String(coilRow?.colour || '').trim() || '—',
    coilNo: cNo || '—',
    coilNoDisplay: displayCoilNumber(cNo) || '—',
    beforeKg: opening,
    afterKg: closing,
    kgUsed: consumed,
    design: String(job.productName || '').trim() || '—',
    meters: Number(coilRow?.metersProduced) || 0,
    conversionKgM: convNum,
    offcutKg: offcut,
    amountNetNgn: paidNet,
    attributedNgn: attributed,
    gauge: gaugeLabel,
    materialType,
    jobId: String(job.jobID || '').trim(),
    cancelled: Boolean(cancelled),
  };
}

function buildNonCoilCoilSectionRow({ job, quote, metersByRef, refunds, cancelled }) {
  const qref = String(job.quotationRef || '').trim();
  return {
    txnDate: jobTxnDateISO(job),
    qtNoDisplay: displayDocNumber(qref) || '—',
    customerProject: customerProjectLabel(job, quote),
    colour: '—',
    coilNo: '—',
    coilNoDisplay: '—',
    beforeKg: 0,
    afterKg: 0,
    kgUsed: Number(job.actualWeightKg) || 0,
    design: String(job.productName || '').trim() || '—',
    meters: Number(job.effectiveOutputMeters ?? job.actualMeters) || 0,
    conversionKgM: null,
    offcutKg: null,
    amountNetNgn: amountPaidNetForJob(quote, refunds, qref),
    attributedNgn: Math.round(allocatedQuotationRevenueForProductionJob(job, quote, metersByRef)),
    gauge: 'Non-coil / offcut',
    materialType: '—',
    jobId: String(job.jobID || '').trim(),
    cancelled: Boolean(cancelled),
  };
}

function splitCoilRowsByFamily(coilRows) {
  const aluminium = [];
  const aluzinc = [];
  const unknown = [];
  for (const r of coilRows) {
    const fam = coilMaterialFamily(r.materialType);
    if (fam === 'aluminium') aluminium.push(r);
    else if (fam === 'aluzinc') aluzinc.push(r);
    else unknown.push(r);
  }
  if (unknown.length) aluminium.push(...unknown);
  return { aluminium, aluzinc };
}

function buildStoneMeterRow({ job, quote, refunds, cancelled }) {
  const qref = String(job.quotationRef || '').trim();
  const usedM = Number(job.actualMeters) || 0;
  return {
    txnDate: jobTxnDateISO(job),
    qtNoDisplay: displayDocNumber(qref) || '—',
    customerProject: customerProjectLabel(job, quote),
    colour: String(quote?.dashboardAttrs?.colour || quote?.colour || '—').trim() || '—',
    productLabel: String(job.productName || '').trim() || '—',
    beforeQty: null,
    afterQty: null,
    qtyUsed: round2(Math.abs(usedM)),
    unit: 'm',
    design: String(job.productName || '').trim() || '—',
    amountNetNgn: amountPaidNetForJob(quote, refunds, qref),
    jobId: String(job.jobID || '').trim(),
    cancelled: Boolean(cancelled),
  };
}

function buildAccessoryRow({ usage, job, quote, refunds, productById, cancelled }) {
  const qref = String(usage.quotationRef || job?.quotationRef || '').trim();
  const pid = String(usage.inventoryProductId || '').trim();
  const product = pid ? productById.get(pid) : null;
  const typeKey = accessoryRegisterTypeKey(String(usage.name || product?.name || ''));
  return {
    txnDate: toIsoDate(usage.postedAtISO || jobTxnDateISO(job)),
    qtNoDisplay: displayDocNumber(qref) || '—',
    customerProject: customerProjectLabel(job, quote),
    itemName: String(usage.name || product?.name || '—').trim(),
    typeKey,
    typeLabel: accessoryRegisterTypeLabel(typeKey),
    beforeQty: null,
    afterQty: null,
    qtyUsed: round2(Number(usage.suppliedQty) || 0),
    unit: String(product?.unit || 'ea'),
    amountNetNgn:
      job && !cancelled ? amountPaidNetForJob(quote, refunds, qref) : null,
    jobId: String(usage.jobID || job?.jobID || '').trim(),
    cancelled: Boolean(cancelled),
  };
}

function buildStoneFlatsheetRow({ usage, job, quote, refunds, cancelled }) {
  const qref = String(usage.quotationRef || job?.quotationRef || '').trim();
  return {
    txnDate: toIsoDate(usage.postedAtISO || jobTxnDateISO(job)),
    qtNoDisplay: displayDocNumber(qref) || '—',
    customerProject: customerProjectLabel(job, quote),
    itemName: String(usage.name || '').trim() || '—',
    lengthM: round2(Number(usage.lengthM) || 0),
    beforeM2: null,
    afterM2: null,
    suppliedM2: round2(Number(usage.suppliedM2) || 0),
    deductionM2: round2(Number(usage.deductionM2) || 0),
    amountNetNgn: job ? amountPaidNetForJob(quote, refunds, qref) : null,
    jobId: String(usage.jobID || job?.jobID || '').trim(),
    cancelled: Boolean(cancelled),
  };
}

function summarizeStoneMeter(rows) {
  let totalM = 0;
  let paid = 0;
  const jobs = new Set();
  for (const r of rows) {
    totalM += Number(r.qtyUsed) || 0;
    if (r.amountNetNgn != null && r.jobId && !jobs.has(r.jobId)) {
      jobs.add(r.jobId);
      paid += Number(r.amountNetNgn) || 0;
    }
  }
  return { lineCount: rows.length, totalMeters: round2(totalM), totalPaidNetNgn: paid };
}

function summarizeFlatsheet(rows) {
  let sup = 0;
  let ded = 0;
  for (const r of rows) {
    sup += Number(r.suppliedM2) || 0;
    ded += Number(r.deductionM2) || 0;
  }
  return { lineCount: rows.length, totalSuppliedM2: round2(sup), totalDeductionM2: round2(ded) };
}

function summarizeAccessory(rows) {
  let qty = 0;
  for (const r of rows) qty += Number(r.qtyUsed) || 0;
  return { lineCount: rows.length, totalQtyUsed: round2(qty) };
}

function groupAccessoryRows(rows) {
  const byType = new Map();
  for (const r of rows) {
    const k = r.typeKey || 'other';
    if (!byType.has(k)) byType.set(k, []);
    byType.get(k).push(r);
  }
  const groups = [...byType.entries()]
    .sort((a, b) => String(a[1][0]?.typeLabel || '').localeCompare(String(b[1][0]?.typeLabel || '')))
    .map(([typeKey, typeRows]) => ({
      typeKey,
      typeLabel: typeRows[0]?.typeLabel || 'Other',
      rows: typeRows.sort((a, b) => String(a.txnDate).localeCompare(String(b.txnDate))),
      subtotals: summarizeAccessory(typeRows),
    }));
  return { groups, totals: summarizeAccessory(rows) };
}

function movementInPeriod(m, startDate, endDate) {
  const iso = toIsoDate(m.dateISO || m.atISO);
  if (!iso) return false;
  return (!startDate || iso >= startDate) && (!endDate || iso <= endDate);
}

function buildOtherMovementRow(m, productById) {
  const pid = String(m.productID || '').trim();
  const product = pid ? productById.get(pid) : null;
  const category = classifyProductCategory(product);
  const qty = Number(m.qty) || 0;
  return {
    txnDate: toIsoDate(m.dateISO || m.atISO),
    movementType: String(m.type || '').trim() || '—',
    ref: String(m.ref || '').trim() || '—',
    productName: String(product?.name || pid || '—'),
    productID: pid || '—',
    qtyDelta: round2(qty),
    unit: String(product?.unit || '').trim() || '—',
    detail: String(m.detail || '').trim() || '—',
    category,
  };
}

/**
 * @param {object} input
 * @param {object[]} input.productionJobs
 * @param {object[]} input.productionJobCoils
 * @param {object[]} input.quotations
 * @param {object[]} input.refunds
 * @param {object[]} input.coilLots
 * @param {object[]} [input.products]
 * @param {object[]} [input.stockMovements]
 * @param {object[]} [input.stoneFlatsheetUsage]
 * @param {object[]} [input.accessoryUsage]
 * @param {string} [input.startDate]
 * @param {string} [input.endDate]
 */
export function buildMaterialTransactionReport(input = {}) {
  const {
    productionJobs = [],
    productionJobCoils = [],
    quotations = [],
    refunds = [],
    coilLots = [],
    products = [],
    stockMovements = [],
    stoneFlatsheetUsage = [],
    accessoryUsage = [],
    startDate,
    endDate,
  } = input;

  const quoteById = new Map((quotations || []).map((q) => [String(q.id ?? '').trim(), q]));
  const coilByNo = new Map((coilLots || []).map((c) => [String(c.coilNo ?? '').trim(), c]));
  const productById = new Map((products || []).map((p) => [String(p.productID ?? '').trim(), p]));
  const jobById = new Map((productionJobs || []).map((j) => [String(j.jobID ?? j.job_id ?? '').trim(), normalizeJobRow(j)]));

  const coilsByJob = new Map();
  for (const c of productionJobCoils || []) {
    const jid = String(c.jobID ?? c.job_id ?? '').trim();
    if (!jid) continue;
    if (!coilsByJob.has(jid)) coilsByJob.set(jid, []);
    coilsByJob.get(jid).push(normalizeCoilRow(c));
  }

  const stoneByJob = new Map();
  for (const u of stoneFlatsheetUsage || []) {
    const jid = String(u.jobID ?? u.job_id ?? '').trim();
    if (!jid) continue;
    if (!stoneByJob.has(jid)) stoneByJob.set(jid, []);
    stoneByJob.get(jid).push(u);
  }

  const accByJob = new Map();
  for (const u of accessoryUsage || []) {
    const jid = String(u.jobID ?? u.job_id ?? '').trim();
    if (!jid) continue;
    if (!accByJob.has(jid)) accByJob.set(jid, []);
    accByJob.get(jid).push(u);
  }

  const metersByRef = metersProducedByQuotationRef(productionJobs);
  const productionJobIds = new Set();

  const completedCoilRows = [];
  const cancelledRows = [];
  const stoneMeterRows = [];
  const cancelledStoneMeter = [];
  const flatsheetRows = [];
  const cancelledFlatsheet = [];
  const accessoryRows = [];
  const cancelledAccessory = [];

  const jobs = (productionJobs || []).map(normalizeJobRow).filter((j) => jobInPeriod(j, startDate, endDate));

  for (const job of jobs) {
    const jid = String(job.jobID || '').trim();
    const cancelled = isCancelled(job);
    const completed = isCompleted(job);
    if (!cancelled && !completed) continue;

    productionJobIds.add(jid);
    const qref = String(job.quotationRef || '').trim();
    const quote = qref ? quoteById.get(qref) : null;
    const coils = coilsByJob.get(jid) || [];
    const stoneLines = stoneByJob.get(jid) || [];
    const accLines = accByJob.get(jid) || [];

    const isStoneMeterJob =
      coils.length === 0 &&
      stoneLines.length === 0 &&
      (Number(job.actualMeters) || 0) !== 0 &&
      (Number(job.actualWeightKg) || 0) === 0;

    if (coils.length > 0) {
      coils.forEach((coilRow, i) => {
        const lot = coilByNo.get(String(coilRow.coilNo || '').trim());
        const row = buildCoilTxnRow({
          job,
          quote,
          coilRow,
          coilLot: lot,
          isFirstCoil: i === 0,
          metersByRef,
          refunds,
          cancelled,
        });
        if (cancelled) cancelledRows.push({ ...row, section: 'coil' });
        else completedCoilRows.push(row);
      });
    } else if (isStoneMeterJob) {
      const row = buildStoneMeterRow({ job, quote, refunds, cancelled });
      if (cancelled) cancelledStoneMeter.push(row);
      else stoneMeterRows.push(row);
    } else if ((Number(job.actualWeightKg) || 0) > 0 || (Number(job.effectiveOutputMeters ?? job.actualMeters) || 0) > 0) {
      const row = buildNonCoilCoilSectionRow({ job, quote, metersByRef, refunds, cancelled });
      if (cancelled) cancelledRows.push({ ...row, section: 'coil' });
      else completedCoilRows.push(row);
    }

    for (const u of stoneLines) {
      const row = buildStoneFlatsheetRow({ usage: u, job, quote, refunds, cancelled });
      if (cancelled) cancelledFlatsheet.push(row);
      else flatsheetRows.push(row);
    }

    for (const u of accLines) {
      const row = buildAccessoryRow({
        usage: u,
        job,
        quote,
        refunds,
        productById,
        cancelled,
      });
      if (cancelled) cancelledAccessory.push(row);
      else accessoryRows.push(row);
    }
  }

  const { aluminium: aluRows, aluzinc: aluzRows } = splitCoilRowsByFamily(completedCoilRows);

  const otherByCategory = {
    aluminium: [],
    aluzinc: [],
    stoneCoated: [],
    accessories: [],
    other: [],
  };

  for (const m of stockMovements || []) {
    if (!movementInPeriod(m, startDate, endDate)) continue;
    const type = String(m.type || '').trim();
    if (PRODUCTION_MOVEMENT_TYPES.has(type) && productionJobIds.has(String(m.ref || '').trim())) {
      continue;
    }
    const row = buildOtherMovementRow(m, productById);
    const bucket = otherByCategory[row.category] || otherByCategory.other;
    bucket.push(row);
  }

  for (const key of Object.keys(otherByCategory)) {
    otherByCategory[key].sort((a, b) => {
      const d = String(a.txnDate).localeCompare(String(b.txnDate));
      if (d !== 0) return d;
      return String(a.ref).localeCompare(String(b.ref));
    });
  }

  const cancelled = {
    coil: cancelledRows.sort((a, b) => String(a.txnDate).localeCompare(String(b.txnDate))),
    stoneMeter: cancelledStoneMeter,
    stoneFlatsheet: cancelledFlatsheet,
    accessories: cancelledAccessory,
    totals: {
      lineCount:
        cancelledRows.length +
        cancelledStoneMeter.length +
        cancelledFlatsheet.length +
        cancelledAccessory.length,
    },
  };

  return {
    period: { startDate: startDate || '', endDate: endDate || '' },
    aluminium: groupCoilRowsByGauge(aluRows),
    aluzinc: groupCoilRowsByGauge(aluzRows),
    stoneCoated: {
      meterRows: stoneMeterRows.sort((a, b) => String(a.txnDate).localeCompare(String(b.txnDate))),
      flatsheetRows: flatsheetRows.sort((a, b) => String(a.txnDate).localeCompare(String(b.txnDate))),
      meterTotals: summarizeStoneMeter(stoneMeterRows),
      flatsheetTotals: summarizeFlatsheet(flatsheetRows),
    },
    accessories: groupAccessoryRows(accessoryRows),
    cancelled,
    otherMovements: otherByCategory,
  };
}

/** @deprecated Use {@link buildMaterialTransactionReport} — flat coil rows for legacy export. */
export function productionTransactionReportRows(
  productionJobs,
  productionJobCoils,
  quotations,
  refunds,
  coilLots,
  startDate,
  endDate
) {
  const pack = buildMaterialTransactionReport({
    productionJobs,
    productionJobCoils,
    quotations,
    refunds,
    coilLots,
    startDate,
    endDate,
  });
  const flat = [];
  for (const fam of ['aluminium', 'aluzinc']) {
    for (const g of pack[fam]?.groups || []) {
      for (const r of g.rows) {
        flat.push({
          qtNoDisplay: r.qtNoDisplay,
          prodDate: r.txnDate,
          customer: r.customerProject,
          color: r.colour,
          gauge: r.gauge,
          materialType: r.materialType,
          coilNoDisplay: r.coilNoDisplay,
          beforeKg: r.beforeKg,
          afterKg: r.afterKg,
          kgUsed: r.kgUsed,
          meters: r.meters,
          conversionKgM: r.conversionKgM,
          design: r.design,
          offcutKg: r.offcutKg,
          paidNgn: r.amountNetNgn,
          refundPaidNgn: null,
          materialCostNgn: 0,
          jobId: r.jobId,
        });
      }
    }
  }
  return flat;
}
