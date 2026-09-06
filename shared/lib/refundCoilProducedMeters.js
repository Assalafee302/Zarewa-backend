import { jobStoneRoofingMetres } from './jobOutputMetres.js';

/**
 * Metres drawn from coil allocations on production jobs (coil consumption only).
 * @param {import('better-sqlite3').Database} db
 * @param {Array<{ job_id?: string, jobID?: string }>} productionJobs
 */
export function coilProducedMetersFromProductionJobs(db, productionJobs) {
  if (!db || !Array.isArray(productionJobs) || productionJobs.length === 0) return 0;
  const stmt = db.prepare(
    `SELECT COALESCE(SUM(COALESCE(meters_produced, 0)), 0) AS s FROM production_job_coils WHERE job_id = ?`
  );
  let sum = 0;
  for (const j of productionJobs) {
    const jid = String(j.job_id ?? j.jobID ?? '').trim();
    if (!jid) continue;
    const row = stmt.get(jid);
    sum += Number(row?.s) || 0;
  }
  return sum;
}

/** Completed job actual_meters (stone-coated / non-coil production). */
export function jobActualMetersFromProductionJobs(productionJobs) {
  if (!Array.isArray(productionJobs) || productionJobs.length === 0) return 0;
  let sum = 0;
  for (const j of productionJobs) {
    const st = String(j.status ?? '').trim().toLowerCase();
    if (st !== 'completed') continue;
    sum += Number(j.actual_meters ?? j.actualMeters) || 0;
  }
  return sum;
}

function coilMetersForJob(db, jobId) {
  if (!db) return 0;
  const jid = String(jobId ?? '').trim();
  if (!jid) return 0;
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(COALESCE(meters_produced, 0)), 0) AS s FROM production_job_coils WHERE job_id = ?`
    )
    .get(jid);
  return Number(row?.s) || 0;
}

/**
 * FG metres credited against unproduced refunds for one completed job.
 * Uses coil allocation metres when present; otherwise job actual metres (offcut/accessories-only completion).
 */
export function jobOutputMetresForUnproducedRefund(db, job) {
  const st = String(job?.status ?? '').trim().toLowerCase();
  if (st !== 'completed') return 0;
  const jid = String(job?.job_id ?? job?.jobID ?? '').trim();
  const coilM = coilMetersForJob(db, jid);
  const actualM = Number(job?.actual_meters ?? job?.actualMeters) || 0;
  const offcutInv = Number(job?.offcut_inventory_meters ?? job?.offcutInventoryMeters) || 0;
  if (coilM > 0.001) return Math.max(actualM, coilM + offcutInv);
  return Math.max(actualM, offcutInv);
}

/**
 * Net stone-coated roofing metres drawn for a job (STONE_CONSUMPTION posts negative qty on draw).
 * Includes post-completion stone metres corrections, which restate these movements.
 */
export function netStoneConsumptionMetresForJob(db, jobId) {
  if (!db) return 0;
  const jid = String(jobId ?? '').trim();
  if (!jid) return 0;
  let row;
  try {
    row = db
      .prepare(
        `SELECT COALESCE(SUM(COALESCE(qty, 0)), 0) AS s FROM stock_movements WHERE ref = ? AND type = 'STONE_CONSUMPTION'`
      )
      .get(jid);
  } catch {
    return 0;
  }
  return Math.max(0, -(Number(row?.s) || 0));
}

/**
 * Metres that reduce unproduced-meterage refund potential.
 * Coil roofing: coil metres per job, or job actual metres when completed from offcut/accessories only.
 * Stone meter quotes: roofing metres only (`actual_roof_m` / STONE_CONSUMPTION) — never max with
 * hybrid flatsheet `actual_meters`, which would overstate roofing vs quoted roofing sheet metres.
 */
export function producedMetersForUnproducedRefund(db, productionJobs, opts = {}) {
  if (!Array.isArray(productionJobs) || productionJobs.length === 0) return 0;
  if (opts.isStoneMeterQuote) {
    let sum = 0;
    for (const j of productionJobs) {
      const st = String(j.status ?? '').trim().toLowerCase();
      if (st !== 'completed') continue;
      const stoneM = netStoneConsumptionMetresForJob(db, j.job_id ?? j.jobID);
      sum += jobStoneRoofingMetres(j, stoneM);
    }
    return sum;
  }
  let sum = 0;
  for (const j of productionJobs) {
    sum += jobOutputMetresForUnproducedRefund(db, j);
  }
  return sum;
}
