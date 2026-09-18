/**
 * Cutting lists may be edited after they are sent to production until the linked job is completed.
 * Cancelled-not-produced is a separate lock (customer change of mind) — not this completed gate.
 */
import { isCancelledNotProducedStatus, isCompletedProductionJobStatus } from '../shared/lib/productionJobStatus.js';

/**
 * @param {import('better-sqlite3').Database} db
 * @param {Record<string, unknown>} row cutting_lists row (needs id, production_registered, production_register_ref)
 * @returns {{ job_id?: string, status?: string } | null}
 */
export function linkedProductionJobForCuttingList(db, row) {
  if (!row) return null;
  const listId = String(row.id ?? '').trim();
  const ref = String(row.production_register_ref || '').trim();
  let job = null;
  if (ref) {
    job = db.prepare(`SELECT job_id, status FROM production_jobs WHERE job_id = ?`).get(ref);
  }
  if (!job && listId) {
    job = db
      .prepare(
        `SELECT job_id, status FROM production_jobs WHERE cutting_list_id = ? ORDER BY created_at_iso DESC, job_id DESC LIMIT 1`
      )
      .get(listId);
  }
  return job || null;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {Record<string, unknown>} row cutting_lists row (needs id, production_registered, production_register_ref)
 */
export function isCuttingListProductionCompleted(db, row) {
  if (!row || !Number(row.production_registered)) return false;
  const job = linkedProductionJobForCuttingList(db, row);
  return Boolean(job) && isCompletedProductionJobStatus(job.status);
}

/**
 * True when the list was cancelled on the production register (not produced).
 * @param {import('better-sqlite3').Database} db
 * @param {Record<string, unknown>} row
 */
export function isCuttingListCancelledNotProduced(db, row) {
  if (!row) return false;
  if (String(row.status || '').trim() === 'Cancelled') return true;
  if (!Number(row.production_registered)) return false;
  const job = linkedProductionJobForCuttingList(db, row);
  return Boolean(job) && isCancelledNotProducedStatus(job.status);
}
