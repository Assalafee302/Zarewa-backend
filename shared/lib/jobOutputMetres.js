/**
 * Total finished production metres for a job.
 *
 * Hybrid stone-coated jobs (Roof + Flatsheet/coil) store roofing in `actual_roof_m` and
 * flatsheet in `actual_flatsheet_m` / `actual_meters`. Pure stone sets both `actual_meters`
 * and `actual_roof_m` to the same value — never sum `actualMeters + actualRoofM`.
 *
 * Prefer R + C + F when any split column is populated; otherwise fall back to
 * `effectiveOutputMeters` / `actualMeters` (legacy coil / pure-stone rows).
 *
 * @param {object|null|undefined} job
 * @returns {number}
 */
export function jobTotalOutputMetres(job) {
  if (!job) return 0;
  const roof = Number(job.actualRoofM ?? job.actual_roof_m) || 0;
  const cladding = Number(job.actualCladdingM ?? job.actual_cladding_m) || 0;
  const flatsheet = Number(job.actualFlatsheetM ?? job.actual_flatsheet_m) || 0;
  const split = roof + cladding + flatsheet;
  if (split > 1e-9) return split;
  return Number(job.effectiveOutputMeters ?? job.actualMeters ?? job.actual_meters) || 0;
}

/** True when the job has any positive finished output metres (including hybrid stone-only). */
export function jobHasPositiveOutputMetres(job) {
  return jobTotalOutputMetres(job) > 1e-9;
}

/**
 * Roofing metres for stone unproduced-refund math (not flatsheet).
 * Prefers `actual_roof_m` / stone draw; legacy pure-stone rows fall back to `actual_meters`
 * when no flatsheet split was recorded.
 *
 * @param {object|null|undefined} job
 * @param {number} [netStoneConsumptionM]
 * @returns {number}
 */
export function jobStoneRoofingMetres(job, netStoneConsumptionM = 0) {
  if (!job) return Math.max(0, Number(netStoneConsumptionM) || 0);
  const roofM = Number(job.actualRoofM ?? job.actual_roof_m) || 0;
  const flatsheetM = Number(job.actualFlatsheetM ?? job.actual_flatsheet_m) || 0;
  const actualM = Number(job.actualMeters ?? job.actual_meters) || 0;
  const stoneM = Math.max(0, Number(netStoneConsumptionM) || 0);
  const legacyPureStone = roofM <= 1e-9 && flatsheetM <= 1e-9 && actualM > 1e-9;
  return Math.max(roofM, stoneM, legacyPureStone ? actualM : 0);
}
