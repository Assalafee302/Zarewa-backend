/**
 * Derived per-category refund ceilings for categories without automatic preview amounts
 * (Order cancellation, Other) — tied to economic floor / cash headroom.
 */

function roundCapMoney(value) {
  return Math.round(Number(value) || 0);
}

/** Categories that must always have a derived cap even when preview suggests ₦0. */
export const REFUND_DERIVED_CAP_CATEGORIES = new Set([
  'Order cancellation',
  'Other',
  /** Prevent re-claiming full accessory/stone shortfall after a cashed refund (cap 0 when no delta). */
  'Accessory shortfall',
  'Stone flatsheet shortfall',
]);

/**
 * @param {{
 *   cashInNgn: number,
 *   totalRefundedNgn?: number,
 *   economicFloor?: {
 *     maxDefensibleRefundNgn?: number | null,
 *     floorDeliveredValueNgn?: number,
 *     producedOutputMeters?: number,
 *     incompleteFloorPricing?: boolean,
 *   } | null,
 * }} p
 * @returns {Record<string, number>}
 */
export function buildDerivedRefundCategoryCapsNgn({ cashInNgn, totalRefundedNgn = 0, economicFloor = null }) {
  const cashIn = roundCapMoney(cashInNgn);
  const refunded = roundCapMoney(totalRefundedNgn);
  const hardCap = Math.max(0, cashIn - refunded);
  const produced = Number(economicFloor?.producedOutputMeters) || 0;
  const floorValue = roundCapMoney(economicFloor?.floorDeliveredValueNgn ?? 0);
  const hasFiniteMax =
    economicFloor?.maxDefensibleRefundNgn != null &&
    Number.isFinite(Number(economicFloor.maxDefensibleRefundNgn));
  // Finite economic floor caps category totals. When incomplete (null maxDefensible),
  // fall back to cash hard cap — create/approve still refuse incomplete unless MD/admin bypass.
  const maxDefensible = hasFiniteMax
    ? roundCapMoney(economicFloor.maxDefensibleRefundNgn)
    : hardCap;

  const cancelCap =
    produced > 0.001 || floorValue > 0 ? Math.max(0, maxDefensible) : Math.max(0, hardCap);
  const otherCap = Math.max(0, maxDefensible);

  return {
    'Order cancellation': cancelCap,
    Other: otherCap,
  };
}

/**
 * Merge preview category caps with derived ceilings (tightest wins).
 * @param {Record<string, number> | null | undefined} previewCaps
 * @param {Record<string, number> | null | undefined} derivedCaps
 */
export function mergeRefundCategoryCapsNgn(previewCaps, derivedCaps) {
  const out = { ...(previewCaps || {}) };
  for (const [cat, derivedRaw] of Object.entries(derivedCaps || {})) {
    const derived = roundCapMoney(derivedRaw);
    if (derived <= 0) continue;
    const preview = roundCapMoney(out[cat]);
    if (preview > 0) out[cat] = Math.min(preview, derived);
    else out[cat] = derived;
  }
  return out;
}
