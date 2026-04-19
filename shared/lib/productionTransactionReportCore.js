/**
 * Production transaction register — pure rows for print/export (client + server).
 * One row per coil allocation line on completed jobs in the date range (by completion date).
 */

function toIsoDate(value) {
  return String(value || '').slice(0, 10);
}

function productionJobIsCompleted(job) {
  return String(job?.status || '').trim() === 'Completed';
}

function productionOutputDateISO(job) {
  return toIsoDate(job?.completedAtISO || job?.endDateISO || '');
}

function refundsPaidOnQuotationNgn(refunds, quotationRef) {
  const q = String(quotationRef || '').trim();
  if (!q) return 0;
  let sum = 0;
  for (const r of refunds || []) {
    const qr = String(r.quotationRef ?? r.quotation_ref ?? '').trim();
    if (qr !== q) continue;
    if (String(r.status || '') === 'Rejected') continue;
    sum += Math.round(Number(r.paidAmountNgn ?? r.paid_amount_ngn) || 0);
  }
  return sum;
}

function quotationRowPaidNgn(q) {
  if (!q) return 0;
  return Math.round(Number(q.paidNgn ?? q.paid_ngn) || 0);
}

/**
 * @param {object[]} productionJobs
 * @param {object[]} productionJobCoils
 * @param {object[]} quotations
 * @param {object[]} refunds
 * @param {object[]} coilLots
 * @param {string} [startDate]
 * @param {string} [endDate]
 */
export function productionTransactionReportRows(
  productionJobs = [],
  productionJobCoils = [],
  quotations = [],
  refunds = [],
  coilLots = [],
  startDate,
  endDate
) {
  const quoteById = new Map((quotations || []).map((q) => [String(q.id ?? '').trim(), q]));
  const coilByNo = new Map((coilLots || []).map((c) => [String(c.coilNo ?? '').trim(), c]));

  const coilsByJob = new Map();
  for (const c of productionJobCoils || []) {
    const jid = String(c.jobID ?? c.job_id ?? '').trim();
    if (!jid) continue;
    if (!coilsByJob.has(jid)) coilsByJob.set(jid, []);
    coilsByJob.get(jid).push(normalizeCoilRow(c));
  }
  for (const arr of coilsByJob.values()) {
    arr.sort((a, b) => (Number(a.sequenceNo) || 0) - (Number(b.sequenceNo) || 0));
  }

  const jobsInRange = (productionJobs || []).map(normalizeJobRow).filter((j) => {
    if (!productionJobIsCompleted(j)) return false;
    const iso = productionOutputDateISO(j);
    if (!iso) return false;
    return (!startDate || iso >= startDate) && (!endDate || iso <= endDate);
  });

  jobsInRange.sort((a, b) => {
    const da = productionOutputDateISO(a) || '';
    const db = productionOutputDateISO(b) || '';
    if (da !== db) return da.localeCompare(db);
    return String(a.jobID || '').localeCompare(String(b.jobID || ''));
  });

  const out = [];

  for (const job of jobsInRange) {
    const jid = String(job.jobID || '').trim();
    const qref = String(job.quotationRef || '').trim();
    const quote = qref ? quoteById.get(qref) : null;
    const paidTotal = quotationRowPaidNgn(quote);
    const refundPaid = refundsPaidOnQuotationNgn(refunds, qref);
    const prodDate = productionOutputDateISO(job) || '';
    const customer = String(job.customerName || '').trim() || '—';
    const design = String(job.productName || '').trim() || '—';

    const coils = coilsByJob.get(jid) || [];

    const pushRow = (coilRow, isFirstCoil) => {
      const opening = Number(coilRow?.openingWeightKg) || 0;
      const closing = Number(coilRow?.closingWeightKg) || 0;
      const consumed = Number(coilRow?.consumedWeightKg) || 0;
      const drift = opening - consumed - closing;
      const offcut =
        Number.isFinite(drift) && Math.abs(drift) >= 0.05 ? Math.round(drift * 100) / 100 : null;

      const cNo = String(coilRow?.coilNo || '').trim();
      const lot = cNo ? coilByNo.get(cNo) : null;
      const unitKg = Math.round(Number(lot?.unitCostNgnPerKg) || 0);
      const materialCostNgn = Math.round(unitKg * consumed);

      const conv = coilRow?.actualConversionKgPerM;
      const convNum = conv != null && Number.isFinite(Number(conv)) ? Number(conv) : null;

      out.push({
        qtNo: qref || '—',
        prodDate,
        customer,
        color: String(coilRow?.colour || '').trim() || '—',
        gauge: String(coilRow?.gaugeLabel || '').trim() || '—',
        coilNo: cNo || '—',
        beforeKg: opening,
        afterKg: closing,
        kgUsed: consumed,
        meters: Number(coilRow?.metersProduced) || 0,
        conversionKgM: convNum,
        design,
        offcutKg: offcut,
        paidNgn: isFirstCoil ? paidTotal : null,
        refundPaidNgn: isFirstCoil ? refundPaid : null,
        materialCostNgn,
        jobId: jid,
      });
    };

    if (coils.length === 0) {
      out.push({
        qtNo: qref || '—',
        prodDate,
        customer,
        color: '—',
        gauge: '—',
        coilNo: '—',
        beforeKg: 0,
        afterKg: 0,
        kgUsed: Number(job.actualWeightKg) || 0,
        meters: Number(job.effectiveOutputMeters ?? job.actualMeters) || 0,
        conversionKgM: null,
        design,
        offcutKg: null,
        paidNgn: paidTotal,
        refundPaidNgn: refundPaid,
        materialCostNgn: 0,
        jobId: jid,
      });
    } else {
      for (let i = 0; i < coils.length; i++) {
        pushRow(coils[i], i === 0);
      }
    }
  }

  return out;
}

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
