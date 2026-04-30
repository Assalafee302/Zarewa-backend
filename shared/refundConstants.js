/**
 * Canonical refund reason categories (Sales UI, preview filters, duplicate checks).
 * Bump when preview suggestion rules change materially (stored on refund snapshot).
 */
export const REFUND_PREVIEW_VERSION = 1;

export const REFUND_REASON_CATEGORY_VALUES = [
  'Order cancellation',
  'Overpayment',
  'Transport issue',
  'Installation issue',
  'Accessory shortfall',
  'Calculation error',
  'Substitution Difference',
  'Other',
];

/** Map legacy / test strings to canonical categories (duplicate detection + preview). */
export const REFUND_CATEGORY_LEGACY_ALIASES = {
  'transport refund': 'Transport issue',
  'accessory refund': 'Accessory shortfall',
  'substitution pricing': 'Substitution Difference',
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
