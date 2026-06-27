/**
 * Metres drawn from coil allocations on production jobs.
 * Offcut-only output (no coil consumption) returns 0 — used for unproduced-meterage refund maths.
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

/**
 * Metres that reduce unproduced-meterage refund potential.
 * Coil roofing: coil allocation metres only (offcut-only FG excluded).
 * Stone meter quotes: completed job actual metres (no coil rows on stone jobs).
 */
export function producedMetersForUnproducedRefund(db, productionJobs, opts = {}) {
  if (opts.isStoneMeterQuote) {
    return jobActualMetersFromProductionJobs(productionJobs);
  }
  return coilProducedMetersFromProductionJobs(db, productionJobs);
}
