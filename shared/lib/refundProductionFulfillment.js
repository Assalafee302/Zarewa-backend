import { quotedCoilSheetPoolMetresFromLines, quotedRoofingSheetMetresFromLines } from './refundQuotationMetres.js';
import {
  coilProducedMetersFromProductionJobs,
  jobActualMetersFromProductionJobs,
  jobOutputMetresForUnproducedRefund,
  producedMetersForUnproducedRefund,
} from './refundCoilProducedMeters.js';

/**
 * Roofing production vs quotation — used for unproduced refund eligibility and approval intel.
 * @param {import('better-sqlite3').Database} db
 * @param {object | null | undefined} quote
 * @param {Array<object>} productionJobs
 * @param {{ isStoneMeterQuote?: boolean, quotedMeters?: number | null }} [opts]
 */
export function buildRefundProductionFulfillmentSummary(db, quote, productionJobs, opts = {}) {
  const stoneMeterQuote = Boolean(opts.isStoneMeterQuote);
  const quotedMeters =
    opts.quotedMeters != null && Number.isFinite(Number(opts.quotedMeters))
      ? Math.max(0, Number(opts.quotedMeters))
      : stoneMeterQuote
        ? quotedRoofingSheetMetresFromLines(quote?.lines_json ?? '')
        : quotedCoilSheetPoolMetresFromLines(quote?.lines_json ?? '');
  const jobs = Array.isArray(productionJobs) ? productionJobs : [];
  const coilProducedMeters = coilProducedMetersFromProductionJobs(db, jobs);
  const jobActualMeters = jobActualMetersFromProductionJobs(jobs);
  const producedMetersForUnproduced = producedMetersForUnproducedRefund(db, jobs, {
    isStoneMeterQuote: stoneMeterQuote,
  });
  const offcutFgMeters = Math.max(0, producedMetersForUnproduced - coilProducedMeters);
  const unproducedMetres = Math.max(0, quotedMeters - producedMetersForUnproduced);
  const fullyProducedRoofing = quotedMeters > 0 && unproducedMetres <= 0.001;
  const hasCompletedJob = jobs.some(
    (j) => String(j.status ?? '').trim().toLowerCase() === 'completed'
  );
  const jobSummaries = jobs.map((j) => {
    const jobId = String(j.job_id ?? j.jobID ?? '').trim();
    const status = String(j.status ?? '').trim();
    const plannedMeters = Number(j.planned_meters ?? j.plannedMeters) || 0;
    const actualMeters = Number(j.actual_meters ?? j.actualMeters) || 0;
    const offcutInventoryMeters =
      Number(j.offcut_inventory_meters ?? j.offcutInventoryMeters) || 0;
    const jobCoilMeters = jobOutputMetresForUnproducedRefund(db, j);
    let outputSource = 'none';
    if (String(status).toLowerCase() === 'completed') {
      if (jobCoilMeters > 0 && actualMeters > jobCoilMeters + 0.001) outputSource = 'coil_and_offcut';
      else if (actualMeters > 0 && coilProducedMetersFromProductionJobs(db, [j]) <= 0.001) {
        outputSource = 'offcut_or_accessories';
      } else if (jobCoilMeters > 0) outputSource = 'coil';
      else if (actualMeters > 0) outputSource = 'offcut_or_accessories';
    }
    return {
      jobId,
      status,
      plannedMeters,
      actualMeters,
      offcutInventoryMeters,
      eligibleProducedMeters: jobCoilMeters,
      outputSource,
    };
  });
  return {
    quotedMeters,
    coilProducedMeters,
    jobActualMeters,
    producedMetersForUnproduced,
    offcutFgMeters,
    unproducedMetres,
    fullyProducedRoofing,
    hasCompletedJob,
    stoneMeterQuote,
    jobs: jobSummaries,
  };
}
