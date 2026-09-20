/**
 * Coil kg event kinds for completion corrections.
 * Floor remaining is GRN received ± these events; Recalc must not silently
 * put kg back onto the coil (that is a stock-fraud class).
 */
export const COIL_KG_EVENT = {
  COMPLETION_RESTORE: 'completion_correction_restore',
  COMPLETION_CONSUME: 'completion_correction_consume',
  COMPLETION_FINISH_ROLL: 'finish_roll',
  COMPLETION_UNDO_FINISH_ROLL: 'undo_finish_roll',
};

export const COIL_KG_RESTORE_BLOCKED = 'COIL_KG_RESTORE_BLOCKED';

/** True when a book-reconcile delta would increase on-hand (put steel back). */
export function coilBookReconcileWouldRestoreKg(onHandDeltaKg, minKg = 0.05) {
  return Number(onHandDeltaKg) > minKg;
}

/**
 * Result when reconcile would restore kg and apply is not allowed.
 * `ok: true` so Recalc still finishes reservation/sync; remaining is unchanged.
 *
 * @param {{
 *   coilNo: string;
 *   beforeOnHandKg: number;
 *   suggestedOnHandKg: number;
 *   onHandDeltaKg: number;
 *   jobsConsumedKgSum?: number;
 *   splitOutKg?: number;
 *   ancillaryNetKg?: number;
 * }} payload
 */
export function coilKgRestoreBlockedResult(payload) {
  const before = Number(payload.beforeOnHandKg) || 0;
  const suggested = Number(payload.suggestedOnHandKg) || 0;
  const delta = Number(payload.onHandDeltaKg) || 0;
  return {
    ok: true,
    coilNo: payload.coilNo,
    unchanged: true,
    restoreBlocked: true,
    code: COIL_KG_RESTORE_BLOCKED,
    error: `On-hand restore of ${delta.toFixed(2)} kg blocked. Coil remaining is not increased by book reconcile — post a reversing control event.`,
    beforeOnHandKg: before,
    afterOnHandKg: before,
    suggestedOnHandKg: suggested,
    onHandDeltaKg: delta,
    jobsConsumedKgSum: payload.jobsConsumedKgSum,
    splitOutKg: payload.splitOutKg,
    ancillaryNetKg: payload.ancillaryNetKg,
  };
}
