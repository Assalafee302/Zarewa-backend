/**
 * Canonical refund reason categories (Sales UI, preview filters, duplicate checks).
 * Frontend copies via `npm run sync:shared` → src/shared/refundConstants.js
 * Bump when preview suggestion rules change materially (stored on refund snapshot).
 */
export const REFUND_PREVIEW_VERSION = 11;

/**
 * Refund quotation picker:
 * - remaining refundable must be at least this (₦), and
 * - automatic preview suggested total must be at least this (₦).
 * Not the material workbook floor and not the refund economic floor.
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

/**
 * Refund categories that refund cash for paid-in-full overpayment or quoted services —
 * not gated by workbook floor value of produced roofing metres.
 */
export const REFUND_ECONOMIC_FLOOR_EXEMPT_CATEGORIES = [
  'Overpayment',
  'Transport issue',
  'Installation issue',
  'Additional services',
];

const FLOOR_EXEMPT_CAT_KEYS = new Set(
  REFUND_ECONOMIC_FLOOR_EXEMPT_CATEGORIES.map((c) => c.toLowerCase())
);

function refundCategoryIsEconomicFloorExempt(cat) {
  const s = String(cat || '')
    .trim()
    .toLowerCase();
  if (!s) return false;
  if (FLOOR_EXEMPT_CAT_KEYS.has(s)) return true;
  // Partial match for legacy / free-text overpayment labels.
  if (s.includes('overpay')) return true;
  return false;
}

/**
 * True when every reason category is overpayment or a quoted service
 * (transport / installation / additional services).
 * @param {unknown} categories
 */
export function refundCategoriesAreEconomicFloorExempt(categories) {
  const cats = (Array.isArray(categories) ? categories : [])
    .map((c) => String(c || '').trim())
    .filter(Boolean);
  if (!cats.length) return false;
  return cats.every((c) => refundCategoryIsEconomicFloorExempt(c));
}

function refundTextLooksFloorExempt(text) {
  const s = String(text || '')
    .trim()
    .toLowerCase();
  if (!s) return false;
  if (FLOOR_EXEMPT_CAT_KEYS.has(s)) return true;
  if (s.includes('overpay')) return true;
  if (s.includes('transport')) return true;
  if (s.includes('install')) return true;
  if (s.includes('additional service')) return true;
  return false;
}

function refundLineIsEconomicFloorExempt(line) {
  const multi = Array.isArray(line?.appliesToCategories) ? line.appliesToCategories : [];
  if (multi.length > 0) {
    return multi.every((c) => refundCategoryIsEconomicFloorExempt(c) || refundTextLooksFloorExempt(c));
  }
  if (refundCategoryIsEconomicFloorExempt(line?.category)) return true;
  return refundTextLooksFloorExempt(line?.category) || refundTextLooksFloorExempt(line?.label);
}

/**
 * True when every included calculation line is floor-exempt (overpayment or quoted service).
 * @param {Array<{ category?: string, amountNgn?: number, include?: boolean, appliesToCategories?: string[], label?: string }> | null | undefined} lines
 */
export function refundCalculationLinesAreEconomicFloorExempt(lines) {
  const included = (Array.isArray(lines) ? lines : []).filter((l) => {
    if (l?.include === false) return false;
    const amt = Math.round(Number(l?.amountNgn) || 0);
    return amt > 0 && String(l?.label ?? l?.category ?? '').trim();
  });
  if (!included.length) return false;
  return included.every((l) => refundLineIsEconomicFloorExempt(l));
}

/**
 * Preview / create / approve: skip production economic-floor cap for this request.
 * @param {{ categories?: unknown, calculationLines?: unknown }} p
 */
export function refundRequestIsEconomicFloorExempt({ categories, calculationLines } = {}) {
  return (
    refundCategoriesAreEconomicFloorExempt(categories) ||
    refundCalculationLinesAreEconomicFloorExempt(calculationLines)
  );
}

/**
 * Sum of included lines that are gated by workbook floor (unproduced, substitution, shortfall, Other, …).
 * Overpayment and quoted services are excluded so mixed Full-refund requests are not blocked by those amounts.
 * @param {Array<{ category?: string, amountNgn?: number, include?: boolean, appliesToCategories?: string[] }> | null | undefined} lines
 */
export function refundFloorGatedAmountNgn(lines) {
  return (Array.isArray(lines) ? lines : []).reduce((sum, line) => {
    if (line?.include === false) return sum;
    const amt = Math.round(Number(line?.amountNgn) || 0);
    if (amt <= 0) return sum;
    if (refundLineIsEconomicFloorExempt(line)) return sum;
    return sum + amt;
  }, 0);
}

/**
 * Whether production-related (floor-gated) amounts exceed the economic floor cap.
 * Mixed requests compare only the gated slice; all-exempt requests never exceed.
 * @param {{
 *   amountNgn?: number,
 *   calculationLines?: unknown,
 *   categories?: unknown,
 *   maxDefensibleRefundNgn?: number | null,
 *   toleranceNgn?: number,
 * }} p
 */
export function refundAmountExceedsEconomicFloorCap({
  amountNgn,
  calculationLines,
  categories,
  maxDefensibleRefundNgn,
  overpaymentExcessNgn = 0,
  toleranceNgn = REFUND_AMOUNT_LINE_TOLERANCE_NGN,
} = {}) {
  if (maxDefensibleRefundNgn == null || !Number.isFinite(Number(maxDefensibleRefundNgn))) return false;
  if (refundRequestIsEconomicFloorExempt({ categories, calculationLines })) return false;
  const cap = Math.round(Number(maxDefensibleRefundNgn));
  const lines = Array.isArray(calculationLines) ? calculationLines : [];
  let gated = lines.length > 0 ? refundFloorGatedAmountNgn(lines) : Math.round(Number(amountNgn) || 0);
  const overpay = Math.max(0, Math.round(Number(overpaymentExcessNgn) || 0));
  if (overpay > 0) {
    const alreadyExempt = (Array.isArray(lines) ? lines : []).reduce((sum, line) => {
      if (line?.include === false) return sum;
      const amt = Math.round(Number(line?.amountNgn) || 0);
      if (amt <= 0 || !refundLineIsEconomicFloorExempt(line)) return sum;
      return sum + amt;
    }, 0);
    gated = Math.max(0, gated - Math.max(0, overpay - alreadyExempt));
  }
  return gated > cap + Math.round(Number(toleranceNgn) || 0);
}

/**
 * UI-only labels for refund reason categories.
 * Canonical `REFUND_REASON_CATEGORY_VALUES` stay unchanged for API / persistence.
 */
export const REFUND_CATEGORY_DISPLAY_LABELS = {
  'Unproduced meterage': 'Unproduced metres',
  'Stone flatsheet shortfall': 'Stone flat-sheet shortfall',
  'Customer commission': 'Agent commission',
};

/** @param {unknown} canonical */
export function refundCategoryDisplayLabel(canonical) {
  const s = String(canonical ?? '').trim();
  if (!s) return '';
  return REFUND_CATEGORY_DISPLAY_LABELS[s] || s;
}

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
  let raw;
  if (Array.isArray(input)) {
    raw = input;
  } else if (input != null && input !== '') {
    const s = String(input).trim();
    if (s.startsWith('[')) {
      try {
        const v = JSON.parse(s);
        raw = Array.isArray(v) ? v : [input];
      } catch {
        raw = [input];
      }
    } else {
      raw = [input];
    }
  } else {
    raw = [];
  }
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
