/** Planned vs actual metre variance warning threshold (Phase 11B).
 * Frontend copies via `npm run sync:shared` → src/shared/lib/productionMetreVariance.js
 */
export const PRODUCTION_METRE_VARIANCE_WARN_PCT = 5;

/**
 * @param {unknown} plannedMeters
 * @param {unknown} actualMeters
 * @returns {number | null} signed variance % (actual relative to planned)
 */
export function metreVariancePct(plannedMeters, actualMeters) {
  const planned = Number(plannedMeters) || 0;
  const actual = Number(actualMeters) || 0;
  if (planned <= 0) return null;
  return Math.round(((actual - planned) / planned) * 1000) / 10;
}

/**
 * @param {unknown} plannedMeters
 * @param {unknown} actualMeters
 * @param {number} [thresholdPct]
 */
export function metreVarianceExceedsThreshold(
  plannedMeters,
  actualMeters,
  thresholdPct = PRODUCTION_METRE_VARIANCE_WARN_PCT
) {
  const pct = metreVariancePct(plannedMeters, actualMeters);
  if (pct == null) return false;
  return Math.abs(pct) > thresholdPct;
}

const OVERRUN_EPS = 0.001;

/**
 * Metre overrun at Complete. Stone hybrid jobs must compare roofing and flatsheet separately:
 * planned_meters is roof-only on stone quotes, so summing stone-consumed + coil/offcut and
 * comparing to that roof plan false-flags the flatsheet/offcut portion as a roofing overrun
 * (e.g. 423 m stone + 7 m coil + 15 m offcut looking like +22 m over a 423 m roof plan).
 *
 * @param {{
 *   stoneHybrid?: boolean,
 *   plannedMeters?: unknown,
 *   plannedRoofM?: unknown,
 *   plannedFlatsheetM?: unknown,
 *   stoneMetersConsumed?: unknown,
 *   flatsheetMeters?: unknown,
 * }} input
 *   `flatsheetMeters` is coil output + offcut FG metres (not stone-flatsheet m²).
 * @returns {{
 *   overrun: boolean,
 *   overMeters: number,
 *   roofOverMeters: number,
 *   flatsheetOverMeters: number,
 *   message: string | null,
 * }}
 */
export function assessProductionMetreOverrun(input = {}) {
  const plannedMeters = Number(input.plannedMeters) || 0;
  const plannedRoofM = Number(input.plannedRoofM) || 0;
  const plannedFlatsheetM = Number(input.plannedFlatsheetM) || 0;
  const stoneM = Number(input.stoneMetersConsumed) || 0;
  const flatsheetM = Number(input.flatsheetMeters) || 0;

  if (input.stoneHybrid) {
    const roofPlan = plannedRoofM > 0 ? plannedRoofM : plannedMeters;
    const roofOver = Math.max(0, stoneM - roofPlan);
    const fsOver = Math.max(0, flatsheetM - plannedFlatsheetM);
    const overrun = roofOver > OVERRUN_EPS || fsOver > OVERRUN_EPS;
    const parts = [];
    if (roofOver > OVERRUN_EPS) {
      parts.push(
        `roofing ${stoneM.toFixed(2)} m vs plan ${roofPlan.toFixed(2)} m (${roofOver.toFixed(2)} m over)`
      );
    }
    if (fsOver > OVERRUN_EPS) {
      parts.push(
        `flatsheet/offcut ${flatsheetM.toFixed(2)} m vs plan ${plannedFlatsheetM.toFixed(2)} m (${fsOver.toFixed(2)} m over)`
      );
    }
    return {
      overrun,
      overMeters: roofOver + fsOver,
      roofOverMeters: roofOver,
      flatsheetOverMeters: fsOver,
      message: overrun
        ? `Output exceeds planned metres (${parts.join('; ')}). Enter a manager overrun remark (at least 3 characters) or reduce metres.`
        : null,
    };
  }

  const output = flatsheetM > 0 ? flatsheetM : stoneM;
  const over = plannedMeters > 0 ? Math.max(0, output - plannedMeters) : 0;
  const overrun = plannedMeters > 0 && output > plannedMeters + OVERRUN_EPS;
  return {
    overrun,
    overMeters: over,
    roofOverMeters: 0,
    flatsheetOverMeters: over,
    message: overrun
      ? `Output (${output.toFixed(2)} m) exceeds planned (${plannedMeters.toFixed(2)} m). Enter a manager remark explaining the overrun to continue.`
      : null,
  };
}
