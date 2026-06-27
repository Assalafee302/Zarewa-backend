/**
 * Canonical refund reason categories (Sales UI, preview filters, duplicate checks).
 * Bump when preview suggestion rules change materially (stored on refund snapshot).
 */
export const REFUND_PREVIEW_VERSION = 10;

/**
 * Refund quotation picker:
 * - remaining refundable must be at least this (₦), and
 * - automatic preview suggested total must be at least this (₦).
 */
export const MIN_REFUND_QUOTATION_REMAINING_NGN = 1000;

/**
 * Whether a quotation row belongs in refund form picklists (dropdown / potential refunds).
 * @param {{
 *   remaining_ngn?: number | null,
 *   remainingNgn?: number | null,
 *   suggested_preview_amount_ngn?: number | null,
 *   suggestedPreviewAmountNgn?: number | null,
 *   eligible_refund_categories?: string[] | null,
 *   eligibleRefundCategories?: string[] | null,
 * }} row
 */
export function quotationMeetsRefundPickerFloor(row) {
  const remaining = Math.round(Number(row?.remaining_ngn ?? row?.remainingNgn) || 0);
  const suggested = Math.round(
    Number(row?.suggested_preview_amount_ngn ?? row?.suggestedPreviewAmountNgn) || 0
  );
  const cats = row?.eligible_refund_categories ?? row?.eligibleRefundCategories;
  const hasCategories = Array.isArray(cats) && cats.length > 0;
  if (!hasCategories) return false;
  if (remaining < MIN_REFUND_QUOTATION_REMAINING_NGN) return false;
  if (suggested < MIN_REFUND_QUOTATION_REMAINING_NGN) return false;
  return true;
}

/** Allowed absolute difference (₦) between refund header amount and sum of included breakdown lines (rounding). */
export const REFUND_AMOUNT_LINE_TOLERANCE_NGN = 1;

export const REFUND_REASON_CATEGORY_VALUES = [
  'Order cancellation',
  'Unproduced meterage',
  'Overpayment',
  'Transport issue',
  'Installation issue',
  'Additional services',
  'Accessory shortfall',
  'Stone flatsheet shortfall',
  'Calculation error',
  'Substitution Difference',
  'Customer commission',
  'Other',
];

/** Map legacy / test strings to canonical categories (duplicate detection + preview). */
export const REFUND_CATEGORY_LEGACY_ALIASES = {
  'unproduced metres': 'Unproduced meterage',
  'unproduced meters': 'Unproduced meterage',
  'meterage shortfall': 'Unproduced meterage',
  'transport refund': 'Transport issue',
  'accessory refund': 'Accessory shortfall',
  'stone shortfall': 'Stone flatsheet shortfall',
  'stone flatsheet refund': 'Stone flatsheet shortfall',
  'substitution pricing': 'Substitution Difference',
  'agent commission': 'Customer commission',
  commission: 'Customer commission',
  adjustment: 'Other',
  'material shortage': 'Other',
};

const KNOWN = new Set(REFUND_REASON_CATEGORY_VALUES.map((s) => s.toLowerCase()));

/**
 * @param {unknown} input
 * @returns {string[]}
 */
export function normalizeRefundReasonCategoriesForApi(input) {
  const raw = Array.isArray(input) ? input : input != null && input !== '' ? [input] : [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const s = String(item ?? '').trim();
    if (!s) continue;
    const alias = REFUND_CATEGORY_LEGACY_ALIASES[s.toLowerCase()];
    const next = alias || (KNOWN.has(s.toLowerCase()) ? s : 'Other');
    const key = next.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(next);
  }
  return out;
}

export function isCanonicalRefundCategory(value) {
  return REFUND_REASON_CATEGORY_VALUES.includes(String(value ?? '').trim());
}
