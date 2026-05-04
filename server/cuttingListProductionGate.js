/**
 * Cutting lists may be edited after they are sent to production until the linked job is completed.
 * @param {import('better-sqlite3').Database} db
 * @param {Record<string, unknown>} row cutting_lists row (needs id, production_registered, production_register_ref)
 */
export function isCuttingListProductionCompleted(db, row) {
  if (!row || !Number(row.production_registered)) return false;
  const listId = String(row.id ?? '').trim();
  const ref = String(row.production_register_ref || '').trim();
  let job = null;
  if (ref) {
    job = db.prepare(`SELECT status FROM production_jobs WHERE job_id = ?`).get(ref);
  }
  if (!job && listId) {
    job = db
      .prepare(
        `SELECT status FROM production_jobs WHERE cutting_list_id = ? ORDER BY created_at_iso DESC, job_id DESC LIMIT 1`
      )
      .get(listId);
  }
  return Boolean(job) && String(job.status) === 'Completed';
}
