/**
 * SQLite write for High/Low conversion reasons. Option lists and validation stay in
 * `shared/productionConversionReasons.js` (frontend syncs that file).
 */

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} jobID
 * @param {{ code: string; band: string; text?: string|null }} reason
 */
export function persistProductionConversionVarianceReason(db, jobID, reason) {
  const cols = db.prepare(`PRAGMA table_info(production_jobs)`).all();
  if (!cols.some((c) => c.name === 'conversion_variance_reason_code')) return;
  db.prepare(
    `UPDATE production_jobs
     SET conversion_variance_reason_code = ?, conversion_variance_reason_text = ?, conversion_variance_band = ?
     WHERE job_id = ?`
  ).run(reason.code, reason.text || null, reason.band, jobID);
}
