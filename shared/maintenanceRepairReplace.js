/**
 * Repair-vs-replace thresholds (machine lifetime maintenance vs asset value).
 * Frontend copies via `npm run sync:shared` → src/shared/maintenanceRepairReplace.js
 */

/** Lifetime maint ≥ this % of purchase cost → watch. */
export const REPAIR_WATCH_PCT_OF_COST = 40;
/** Lifetime maint ≥ this % of purchase cost → replace review. */
export const REPAIR_REPLACE_PCT_OF_COST = 70;
/** Lifetime maint ≥ this % of NBV → replace review. */
export const REPAIR_REPLACE_PCT_OF_NBV = 100;

/**
 * @param {{
 *   lifetimeMaintenanceNgn: number,
 *   costNgn: number | null | undefined,
 *   netBookValueNgn: number | null | undefined,
 *   replacementRequired?: boolean,
 * }} input
 * @returns {'ok' | 'watch' | 'replace_review' | 'urgent'}
 */
export function repairReplaceFlag(input) {
  const life = Math.max(0, Math.round(Number(input.lifetimeMaintenanceNgn) || 0));
  const cost = Math.round(Number(input.costNgn) || 0);
  const nbv = Math.round(Number(input.netBookValueNgn) || 0);
  if (input.replacementRequired) return 'urgent';
  if (life <= 0) return 'ok';
  const pctOfCost = cost > 0 ? (life / cost) * 100 : 0;
  const pctOfNbv = nbv > 0 ? (life / nbv) * 100 : 0;
  if (pctOfCost >= REPAIR_REPLACE_PCT_OF_COST || pctOfNbv >= REPAIR_REPLACE_PCT_OF_NBV) {
    return 'replace_review';
  }
  if (pctOfCost >= REPAIR_WATCH_PCT_OF_COST) return 'watch';
  return 'ok';
}

/**
 * @param {'ok' | 'watch' | 'replace_review' | 'urgent'} flag
 */
export function repairReplaceLabel(flag) {
  switch (flag) {
    case 'urgent':
      return 'Replacement flagged';
    case 'replace_review':
      return 'Replace review';
    case 'watch':
      return 'Watch';
    default:
      return 'OK';
  }
}
