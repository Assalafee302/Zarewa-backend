/**
 * Production-register job statuses.
 *
 * Cancelled = not produced (customer change of mind). Terminal for refunds.
 * Returned = released back to Waiting so Sales can edit the quotation.
 * Return-to-planned (Running → Planned) is a shop-floor recall, not this release.
 */

export const PRODUCTION_JOB_STATUS = {
  PLANNED: 'Planned',
  RUNNING: 'Running',
  COMPLETED: 'Completed',
  CANCELLED: 'Cancelled',
  RETURNED: 'Returned',
};

export const CUTTING_LIST_STATUS_CANCELLED = 'Cancelled';

export function productionJobStatusKey(status) {
  return String(status || '')
    .trim()
    .toLowerCase();
}

/** Planned or Running — still on the shop-floor queue. */
export function isActiveProductionQueueStatus(status) {
  const st = productionJobStatusKey(status);
  return st === 'planned' || st === 'running';
}

/** Customer change of mind; metres were not produced. */
export function isCancelledNotProducedStatus(status) {
  return productionJobStatusKey(status) === 'cancelled';
}

/** Released from the register so Sales can edit the quotation / cutting list. */
export function isReturnedToWaitingStatus(status) {
  return productionJobStatusKey(status) === 'returned';
}

export function isCompletedProductionJobStatus(status) {
  return productionJobStatusKey(status) === 'completed';
}

/** Cannot start, allocate, or complete. */
export function isInactiveProductionJobStatus(status) {
  const st = productionJobStatusKey(status);
  return st === 'completed' || st === 'cancelled' || st === 'returned';
}

/** Production is closed for refund eligibility (completed output or cancelled-not-produced). */
export function isProductionClosedForRefundStatus(status) {
  const st = productionJobStatusKey(status);
  return st === 'completed' || st === 'cancelled';
}

/**
 * Lowercase statuses that do not occupy the shop-floor queue.
 * Returned (sent back to Sales) must not look like an open Planned/Running job, or a later
 * completed run on the same quotation would stay blocked for refunds.
 */
export const PRODUCTION_JOB_OFF_QUEUE_STATUSES_SQL = `'completed', 'cancelled', 'returned'`;

/**
 * Sales must not change quotation lines while the job is on the register or cancelled-not-produced.
 * Return-to-waiting clears this.
 * @param {string} [jobStatus]
 */
export function quotationLineEditBlockedByProductionStatus(jobStatus) {
  return isActiveProductionQueueStatus(jobStatus) || isCancelledNotProducedStatus(jobStatus);
}
