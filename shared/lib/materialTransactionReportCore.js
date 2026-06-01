/**
 * Material transaction register — production + other stock movements in period.
 * Grouped: aluminium / aluzinc (by gauge, coil sort), stone-coated, accessories,
 * cancelled jobs, other movements.
 */

import { displayLast4, displayTxnDateShort } from './reportDisplayFormat.js';
import {
  allocatedQuotationRevenueForProductionJob,
  metersProducedByQuotationRef,
  productionOutputDateISO,
} from './liveAnalytics.js';
import { quotationHasFlatSheetLine } from './stoneCoatedQuotationPolicy.js';
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

/** Match stock register colour abbreviations from master data. */
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

function quotationLines(quote) {
  const ql = quote?.quotationLines;
  return ql && typeof ql === 'object' ? ql : {};
}

function quotationGaugeLabel(quote) {
  const ql = quotationLines(quote);
  const g = String(
    ql.materialGauge || ql.products?.[0]?.gauge || ql.products?.[0]?.gaugeLabel || ''
  ).trim();
  return g || '—';
}

function quotationColourRaw(quote) {
  const ql = quotationLines(quote);
  return String(ql.materialColor || ql.products?.[0]?.colour || ql.products?.[0]?.color || '').trim();
}

/** Quotation roofing design: Metra, Indus 6, Metcoppo, or Flatsheet. */
export function quotationDesignLabel(quote) {
  if (!quote) return '—';
  const ql = quotationLines(quote);
  const products = Array.isArray(ql.products) ? ql.products : [];
  if (quotationHasFlatSheetLine(products)) return 'Flatsheet';

  const blob = [
    ql.materialDesign,
    ql.products?.[0]?.profile,
    ql.products?.[0]?.design,
    ql.products?.[0]?.name,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();

  if (/flatsheet|flat\s*sheet/.test(blob)) return 'Flatsheet';
  if (/metcoppo|step\s*tile|steptile/.test(blob)) return 'Metcoppo';
  if (/indus\s*6|indus6|industrial\s*6/.test(blob)) return 'Indus 6';
  if (/metra|metral/.test(blob)) return 'Metra';

  for (const p of products) {
    const n = String(p.name || '').toLowerCase();
    if (/stone\s*flatsheet|flat\s*sheet/.test(n)) return 'Flatsheet';
    if (/metcoppo|step\s*tile/.test(n)) return 'Metcoppo';
    if (/indus\s*6|indus6/.test(n)) return 'Indus 6';
    if (/metra/.test(n)) return 'Metra';
  }

  const d = String(ql.materialDesign || ql.products?.[0]?.profile || '').trim();
  if (d) {
    const k = d.toLowerCase();
    if (k.includes('metcoppo')) return 'Metcoppo';
    if (k.includes('indus')) return 'Indus 6';
    if (k.includes('metra')) return 'Metra';
    return d.length > 12 ? d.slice(0, 12) : d;
  }
  return '—';
}

function coilStockRemark(coilLot, opening, closing, consumed) {
  const parts = [];
  const form = String(coilLot?.stockForm || 'coil').toLowerCase();
  if (opening > 0) parts.push(form === 'roll' ? 'Start: roll' : 'Start: new coil');
  const st = String(coilLot?.currentStatus || '').toLowerCase();
  const finished =
    consumed > 0 && (closing <= 1.5 || st === 'finished' || st === 'consumed' || st === 'depleted');
  if (finished) parts.push('Finished coil');
  return parts.length ? parts.join(' · ') : '—';
}

function toIsoDate(value) {
  return String(value || '').slice(0, 10);
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

const BALANCE_GAP_TOLERANCE_KG = 1.5;
const BALANCE_GAP_TOLERANCE_M = 0.5;

function balancesNearlyEqual(prevAfter, nextBefore, tolerance) {
  if (prevAfter == null || nextBefore == null) return true;
  const a = Number(prevAfter);
  const b = Number(nextBefore);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return true;
  return Math.abs(a - b) <= tolerance;
}

function balanceGapNote(prevAfter, nextBefore, unit) {
  return `Gap: prev after ${fmtBalance(prevAfter)} ≠ before ${fmtBalance(nextBefore)}${unit ? ` ${unit}` : ''}`;
}

function fmtBalance(v) {
  return round2(v).toLocaleString(undefined, { maximumFractionDigits: 2 });
}

/**
 * Within the same continuity stream (e.g. one coil), each line's before should equal the previous line's after.
 */
function applyBalanceContinuity(rows, opts) {
  const {
    continuityKey = () => '',
    beforeField,
    afterField,
    tolerance,
    unit = '',
  } = opts;
  let prevRow = null;
  let prevKey = '';
  return rows.map((row) => {
    const key = continuityKey(row);
    const before = row[beforeField];
    let balanceBreak = false;
    let balanceNote = null;
    if (prevRow && key && key === prevKey) {
      const prevAfter = prevRow[afterField];
      if (!balancesNearlyEqual(prevAfter, before, tolerance)) {
        balanceBreak = true;
        balanceNote = balanceGapNote(prevAfter, before, unit);
      }
    }
    prevRow = row;
    prevKey = key;
    if (!balanceNote) return row;
    const baseRemark = row.remark && row.remark !== '—' ? row.remark : '';
    return {
      ...row,
      balanceBreak,
      balanceNote,
      remark: [baseRemark, balanceNote].filter(Boolean).join(' · '),
    };
  });
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

function quoteProductHints(quote) {
  const prods = quote?.quotationLines?.products || [];
  let hasStone = false;
  let hasCoilProduct = false;
  let hasAccessory = false;
  for (const p of prods) {
    const n = String(p.name || p.productName || '').toLowerCase();
    const mat = String(p.materialType || p.material || '').toLowerCase();
    if (/stone/.test(n) || /stone/.test(mat)) hasStone = true;
    if (/aluminium|aluzinc|aluminum|coil|roofing|corrugated|gauge/.test(`${n} ${mat}`)) hasCoilProduct = true;
    if (/accessor|nail|screw|ridge|sealant|clip|fastener/.test(n)) hasAccessory = true;
  }
  return { hasStone, hasCoilProduct, hasAccessory };
}

function inferFamilyFromProductName(productName) {
  const n = String(productName || '').toLowerCase();
  if (/aluzinc/.test(n)) return 'aluzinc';
  if (/aluminium|aluminum|\balu\b/.test(n)) return 'aluminium';
  return null;
}

/**
 * Where to route jobs with no coil allocation lines.
 * @returns {'stone_meter'|'accessory_only'|'offcut_production'|'none'}
 */
function resolveJobOutputKind(job, quote, coils, accLines) {
  if (coils.length > 0) return 'none';
  const meters = Number(job.actualMeters) || 0;
  const weight = Number(job.actualWeightKg) || 0;
  const hints = quoteProductHints(quote);
  const products = quotationLines(quote).products || [];

  if (quotationHasFlatSheetLine(products) && meters === 0 && weight === 0) {
    return accLines.length > 0 ? 'accessory_only' : 'none';
  }
  if (meters !== 0 && weight === 0) return 'stone_meter';
  if (hints.hasStone && !hints.hasCoilProduct && meters !== 0) return 'stone_meter';
  if (accLines.length > 0 && meters === 0 && weight === 0) return 'accessory_only';
  if (hints.hasAccessory && !hints.hasCoilProduct && !hints.hasStone && meters === 0 && weight === 0) {
    return 'accessory_only';
  }
  if (meters > 0 || weight > 0) return 'offcut_production';
  if (accLines.length > 0) return 'accessory_only';
  return 'none';
}

function offcutKgFromCoilWeights(opening, consumed, closing) {
  if (!(opening > 0 && consumed > 0)) return null;
  const drift = opening - consumed - closing;
  const threshold = Math.max(1, opening * 0.01);
  if (!Number.isFinite(drift) || Math.abs(drift) < threshold) return null;
  return round2(drift);
}

function rowDateFields(iso) {
  const txnDate = toIsoDate(iso);
  return { txnDate, txnDateDisplay: displayTxnDateShort(txnDate) };
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
        const d = String(a.txnDate || '').localeCompare(String(b.txnDate || ''));
        if (d !== 0) return d;
        return String(a.jobId || '').localeCompare(String(b.jobId || ''));
      });
      const linkedRows = applyBalanceContinuity(gaugeRows, {
        continuityKey: (r) => String(r.coilNo || '').trim(),
        beforeField: 'beforeKg',
        afterField: 'afterKg',
        tolerance: BALANCE_GAP_TOLERANCE_KG,
        unit: 'kg',
      });
      return { gaugeLabel, rows: linkedRows, subtotals: summarizeCoilRows(linkedRows) };
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
  masterData,
}) {
  const qref = String(job.quotationRef || '').trim();
  const opening = Number(coilRow?.openingWeightKg) || 0;
  const closing = Number(coilRow?.closingWeightKg) || 0;
  const consumed = Number(coilRow?.consumedWeightKg) || 0;
  const cNo = String(coilRow?.coilNo || '').trim();
  const offcut = cNo ? offcutKgFromCoilWeights(opening, consumed, closing) : null;
  const materialType = String(coilLot?.materialTypeName || '').trim() || '—';
  const gaugeLabel = String(coilRow?.gaugeLabel || '').trim() || '—';
  const conv = coilRow?.actualConversionKgPerM;
  const convRaw = conv != null && Number.isFinite(Number(conv)) ? Number(conv) : null;
  const convNum = convRaw != null && convRaw > 0 ? round2(convRaw) : null;
  const attributed = isFirstCoil
    ? Math.round(allocatedQuotationRevenueForProductionJob(job, quote, metersByRef))
    : null;
  const paidNet = isFirstCoil ? amountPaidNetForJob(quote, refunds, qref) : null;

  const colourRaw = String(coilRow?.colour || quotationColourRaw(quote) || '').trim();
  const dates = rowDateFields(jobTxnDateISO(job));
  return {
    ...dates,
    qtNoDisplay: displayLast4(qref) || '—',
    customerProject: customerProjectLabel(job, quote),
    colour: colourAbbrevForReport(masterData, colourRaw),
    coilNo: cNo || '—',
    coilNoDisplay: cNo ? displayLast4(cNo) : '—',
    beforeKg: opening,
    afterKg: closing,
    kgUsed: consumed,
    design: quotationDesignLabel(quote),
    meters: Number(coilRow?.metersProduced) || 0,
    conversionKgM: convNum,
    offcutKg: offcut,
    remark: coilStockRemark(coilLot, opening, closing, consumed),
    amountNetNgn: paidNet,
    attributedNgn: attributed,
    gauge: gaugeLabel,
    materialType,
    jobId: String(job.jobID || '').trim(),
    cancelled: Boolean(cancelled),
  };
}

function buildOffcutProductionRow({ job, quote, metersByRef, refunds, cancelled }) {
  const qref = String(job.quotationRef || '').trim();
  const dates = rowDateFields(jobTxnDateISO(job));
  return {
    ...dates,
    qtNoDisplay: displayLast4(qref) || '—',
    customerProject: customerProjectLabel(job, quote),
    design: quotationDesignLabel(quote),
    metres: round2(Number(job.effectiveOutputMeters ?? job.actualMeters) || 0),
    kgUsed: round2(Number(job.actualWeightKg) || 0),
    amountNetNgn: amountPaidNetForJob(quote, refunds, qref),
    attributedNgn: Math.round(allocatedQuotationRevenueForProductionJob(job, quote, metersByRef)),
    jobId: String(job.jobID || '').trim(),
    cancelled: Boolean(cancelled),
  };
}

function splitCoilRowsByFamily(coilRows) {
  const aluminium = [];
  const aluzinc = [];
  const unclassified = [];
  for (const r of coilRows) {
    const fam = coilMaterialFamily(r.materialType);
    if (fam === 'aluminium') aluminium.push(r);
    else if (fam === 'aluzinc') aluzinc.push(r);
    else unclassified.push(r);
  }
  return { aluminium, aluzinc, unclassified };
}

function buildStoneMeterRow({ job, quote, refunds, cancelled, masterData, drawSnapshot }) {
  const qref = String(job.quotationRef || '').trim();
  const usedM = round2(Math.abs(Number(job.actualMeters) || 0));
  const snap = drawSnapshot || {};
  const dates = rowDateFields(jobTxnDateISO(job));
  const colourRaw = quotationColourRaw(quote);
  return {
    ...dates,
    qtNoDisplay: displayLast4(qref) || '—',
    customerProject: customerProjectLabel(job, quote),
    colour: colourAbbrevForReport(masterData, colourRaw),
    gaugeLabel: quotationGaugeLabel(quote),
    design: quotationDesignLabel(quote),
    beforeM: snap.beforeM != null ? round2(snap.beforeM) : null,
    afterM: snap.afterM != null ? round2(snap.afterM) : null,
    stoneProductId: String(snap.productId || job.productID || job.product_id || '').trim(),
    metresUsed: usedM,
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
  const dates = rowDateFields(toIsoDate(usage.postedAtISO || jobTxnDateISO(job)));
  return {
    ...dates,
    qtNoDisplay: displayLast4(qref) || '—',
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

function summarizeStoneGaugeRows(rows) {
  let totalUsed = 0;
  let paid = 0;
  const jobs = new Set();
  for (const r of rows) {
    totalUsed += Number(r.metresUsed) || 0;
    if (r.amountNetNgn != null && r.jobId && !jobs.has(r.jobId)) {
      jobs.add(r.jobId);
      paid += Number(r.amountNetNgn) || 0;
    }
  }
  return { lineCount: rows.length, totalMetresUsed: round2(totalUsed), totalPaidNetNgn: paid };
}

function groupStoneMeterRows(rows) {
  const byGauge = new Map();
  for (const r of rows) {
    const g = r.gaugeLabel || '—';
    if (!byGauge.has(g)) byGauge.set(g, []);
    byGauge.get(g).push(r);
  }
  const groups = [...byGauge.entries()]
    .sort((a, b) => gaugeSortKey(a[0]) - gaugeSortKey(b[0]) || String(a[0]).localeCompare(String(b[0])))
    .map(([gaugeLabel, gaugeRows]) => {
      gaugeRows.sort((a, b) => {
        const p = String(a.stoneProductId || '').localeCompare(String(b.stoneProductId || ''));
        if (p !== 0) return p;
        const d = String(a.txnDate || '').localeCompare(String(b.txnDate || ''));
        if (d !== 0) return d;
        return String(a.jobId || '').localeCompare(String(b.jobId || ''));
      });
      const linkedRows = applyBalanceContinuity(gaugeRows, {
        continuityKey: (r) => String(r.stoneProductId || r.gaugeLabel || '').trim(),
        beforeField: 'beforeM',
        afterField: 'afterM',
        tolerance: BALANCE_GAP_TOLERANCE_M,
        unit: 'm',
      });
      return { gaugeLabel, rows: linkedRows, subtotals: summarizeStoneGaugeRows(linkedRows) };
    });
  return { groups, totals: summarizeStoneGaugeRows(rows) };
}

/** Opening stock at period start + per-job before/after for stone metre draws. */
function buildStoneDrawSnapshots(products, movementsThroughEnd, movementsInPeriod, startDate) {
  const stonePids = new Set();
  for (const p of products || []) {
    if (classifyProductCategory(p) === 'stoneCoated') stonePids.add(String(p.productID || '').trim());
  }
  const running = new Map();
  for (const p of products || []) {
    const pid = String(p.productID || '').trim();
    if (!stonePids.has(pid)) continue;
    running.set(pid, Number(p.stockLevel) || 0);
  }
  for (const m of movementsThroughEnd || []) {
    const iso = toIsoDate(m.dateISO || m.atISO);
    const pid = String(m.productID || '').trim();
    if (!stonePids.has(pid) || !startDate || !iso || iso >= startDate) continue;
    running.set(pid, (running.get(pid) || 0) - (Number(m.qty) || 0));
  }
  const byJobRef = new Map();
  const sorted = (movementsInPeriod || [])
    .filter((m) => stonePids.has(String(m.productID || '').trim()) && m.type === 'STONE_CONSUMPTION')
    .sort((a, b) => {
      const d = String(a.dateISO || a.atISO).localeCompare(String(b.dateISO || b.atISO));
      if (d !== 0) return d;
      return String(a.id || '').localeCompare(String(b.id || ''));
    });
  for (const m of sorted) {
    const pid = String(m.productID || '').trim();
    const before = running.get(pid) ?? 0;
    const after = before + (Number(m.qty) || 0);
    running.set(pid, after);
    const ref = String(m.ref || '').trim();
    if (ref) byJobRef.set(ref, { beforeM: before, afterM: after, productId: pid });
  }
  return byJobRef;
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
  const dates = rowDateFields(toIsoDate(m.dateISO || m.atISO));
  return {
    ...dates,
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
 * @param {object} [input.masterData]
 * @param {object[]} [input.stockMovementsThroughEnd]
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
    stockMovementsThroughEnd = [],
    masterData = null,
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

  const stoneDrawSnapshots = buildStoneDrawSnapshots(
    products,
    stockMovementsThroughEnd.length ? stockMovementsThroughEnd : stockMovements,
    stockMovements,
    startDate
  );

  const accByJob = new Map();
  for (const u of accessoryUsage || []) {
    const jid = String(u.jobID ?? u.job_id ?? '').trim();
    if (!jid) continue;
    if (!accByJob.has(jid)) accByJob.set(jid, []);
    accByJob.get(jid).push(u);
  }

  const metersByRef = metersProducedByQuotationRef(productionJobs);

  const completedCoilRows = [];
  const offcutProductionRows = [];
  const cancelledRows = [];
  const stoneMeterRows = [];
  const cancelledStoneMeter = [];
  const accessoryRows = [];
  const cancelledAccessory = [];

  const jobs = (productionJobs || []).map(normalizeJobRow).filter((j) => jobInPeriod(j, startDate, endDate));

  for (const job of jobs) {
    const jid = String(job.jobID || '').trim();
    const cancelled = isCancelled(job);
    const completed = isCompleted(job);
    if (!cancelled && !completed) continue;

    const qref = String(job.quotationRef || '').trim();
    const quote = qref ? quoteById.get(qref) : null;
    const coils = coilsByJob.get(jid) || [];
    const accLines = accByJob.get(jid) || [];

    const outputKind = resolveJobOutputKind(job, quote, coils, accLines);

    if (coils.length > 0) {
      coils.forEach((coilRow, i) => {
        const lot = coilByNo.get(String(coilRow.coilNo || '').trim());
        let row = buildCoilTxnRow({
          job,
          quote,
          coilRow,
          coilLot: lot,
          isFirstCoil: i === 0,
          metersByRef,
          refunds,
          cancelled,
          masterData,
        });
        if (!coilMaterialFamily(row.materialType)) {
          const inferred = inferFamilyFromProductName(job.productName);
          if (inferred) row = { ...row, materialType: inferred === 'aluzinc' ? 'Aluzinc' : 'Aluminium' };
        }
        if (cancelled) cancelledRows.push({ ...row, section: 'coil' });
        else completedCoilRows.push(row);
      });
    } else if (outputKind === 'stone_meter') {
      const row = buildStoneMeterRow({
        job,
        quote,
        refunds,
        cancelled,
        masterData,
        drawSnapshot: stoneDrawSnapshots.get(jid),
      });
      if (cancelled) cancelledStoneMeter.push(row);
      else stoneMeterRows.push(row);
    } else if (outputKind === 'offcut_production') {
      const row = buildOffcutProductionRow({ job, quote, metersByRef, refunds, cancelled });
      if (cancelled) cancelledRows.push({ ...row, section: 'offcut' });
      else offcutProductionRows.push(row);
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

  const { aluminium: aluRows, aluzinc: aluzRows, unclassified: unclassifiedCoilRows } =
    splitCoilRowsByFamily(completedCoilRows);

  const cancelled = {
    coil: cancelledRows.sort((a, b) => String(a.txnDate).localeCompare(String(b.txnDate))),
    stoneMeter: cancelledStoneMeter,
    accessories: cancelledAccessory,
    totals: {
      lineCount: cancelledRows.length + cancelledStoneMeter.length + cancelledAccessory.length,
    },
  };

  const stoneSorted = stoneMeterRows.sort((a, b) => String(a.txnDate).localeCompare(String(b.txnDate)));

  return {
    period: { startDate: startDate || '', endDate: endDate || '' },
    aluminium: groupCoilRowsByGauge(aluRows),
    aluzinc: groupCoilRowsByGauge(aluzRows),
    unclassifiedCoil: groupCoilRowsByGauge(unclassifiedCoilRows),
    offcutProduction: {
      rows: offcutProductionRows.sort((a, b) => String(a.txnDate).localeCompare(String(b.txnDate))),
      totals: {
        lineCount: offcutProductionRows.length,
        totalMetres: round2(offcutProductionRows.reduce((s, r) => s + (Number(r.metres) || 0), 0)),
      },
    },
    stoneCoated: groupStoneMeterRows(stoneSorted),
    accessories: groupAccessoryRows(accessoryRows),
    cancelled,
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
