/**
 * Storekeeper High/Low conversion-reason presets and isomorphic validation.
 * SQLite persist lives in `server/operations/productionConversionVariancePersist.js`.
 * Frontend copies via `npm run sync:shared` → src/shared/productionConversionReasons.js
 */

/** @typedef {{ code: string; label: string; requiresText?: boolean }} ConversionReasonOption */

/** @type {ConversionReasonOption[]} */
export const HIGH_CONVERSION_REASON_OPTIONS = [
  { code: 'small_meter', label: 'Small metre — length under-reported' },
  { code: 'scale_issue', label: 'Scale / weighbridge issue (opening or closing kg)' },
  { code: 'gauge_thick', label: 'Gauge thicker than catalogue / spec' },
  { code: 'head_trim', label: 'Head or edge trim counted in consumption' },
  { code: 'offcut_in_meters', label: 'Offcut length wrongly included in produced metres' },
  { code: 'damaged_coil', label: 'Damaged / rusty coil — scrap counted as run' },
  { code: 'wrong_coil', label: 'Wrong coil selected or mix-up' },
  { code: 'supplier_heavy', label: 'Supplier coil heavier than PO conversion' },
];

/** @type {ConversionReasonOption[]} */
export const LOW_CONVERSION_REASON_OPTIONS = [
  { code: 'long_meter', label: 'Long metre — length over-reported' },
  { code: 'scale_issue', label: 'Scale / weighbridge issue (opening or closing kg)' },
  { code: 'gauge_thin', label: 'Gauge thinner than catalogue / spec' },
  { code: 'offcut_return', label: 'Large offcut returned — metres include unused stock' },
  { code: 'finish_roll_early', label: 'Roll finished early but metres still logged' },
  { code: 'damages_scrapped', label: 'Damages scrapped but metres still counted' },
  { code: 'wrong_opening', label: 'Opening weight too low vs actual on roll' },
  { code: 'supplier_light', label: 'Supplier coil lighter than PO conversion' },
];

/** @type {ConversionReasonOption[]} */
export const COMMON_CONVERSION_REASON_OPTIONS = [
  { code: 'other', label: 'Other (describe below)', requiresText: true },
  { code: 'unsure', label: "I don't know" },
];

const ALL_BY_CODE = new Map(
  [...HIGH_CONVERSION_REASON_OPTIONS, ...LOW_CONVERSION_REASON_OPTIONS, ...COMMON_CONVERSION_REASON_OPTIONS].map(
    (o) => [o.code, o]
  )
);

/**
 * @param {'High'|'Low'|string|null|undefined} band
 * @returns {ConversionReasonOption[]}
 */
export function conversionReasonOptionsForBand(band) {
  const b = String(band ?? '').trim();
  if (b === 'High') return [...HIGH_CONVERSION_REASON_OPTIONS, ...COMMON_CONVERSION_REASON_OPTIONS];
  if (b === 'Low') return [...LOW_CONVERSION_REASON_OPTIONS, ...COMMON_CONVERSION_REASON_OPTIONS];
  return [];
}

/**
 * @param {string} code
 * @param {'High'|'Low'|string|null|undefined} [band]
 */
export function findConversionReasonOption(code, band = null) {
  const c = String(code ?? '').trim();
  if (!c) return null;
  if (band) {
    return conversionReasonOptionsForBand(band).find((o) => o.code === c) ?? null;
  }
  return ALL_BY_CODE.get(c) ?? null;
}

/**
 * @param {string} code
 * @param {string} [text]
 * @param {'High'|'Low'|string|null|undefined} [band]
 */
export function conversionVarianceReasonLabel(code, text = '', band = null) {
  const opt = findConversionReasonOption(code, band);
  const base = opt?.label || (code ? String(code) : '');
  if (opt?.code === 'other') {
    const t = String(text ?? '').trim();
    return t ? `${base}: ${t}` : base;
  }
  return base;
}

/**
 * Require a storekeeper reason when completion posts High/Low conversion.
 *
 * @param {{ conversionVarianceReasonCode?: string; conversionVarianceReasonText?: string }} payload
 * @param {'High'|'Low'|'OK'|'Watch'|'Pending'|string} alertBand
 */
export function validateConversionVarianceReason(payload, alertBand) {
  const band = String(alertBand ?? '').trim();
  if (band !== 'High' && band !== 'Low') {
    return { ok: true };
  }
  const code = String(payload?.conversionVarianceReasonCode ?? payload?.conversion_variance_reason_code ?? '').trim();
  if (!code) {
    return {
      ok: false,
      error: `Conversion is ${band.toLowerCase()} — select a reason from the list before completing.`,
    };
  }
  const opt = findConversionReasonOption(code, band);
  if (!opt) {
    return {
      ok: false,
      error: `Conversion reason "${code}" is not valid for a ${band.toLowerCase()} alert.`,
    };
  }
  if (opt.requiresText) {
    const text = String(payload?.conversionVarianceReasonText ?? payload?.conversion_variance_reason_text ?? '').trim();
    if (text.length < 8) {
      return {
        ok: false,
        error: 'For “Other”, enter a short description (at least 8 characters).',
      };
    }
  }
  return { ok: true, code, band, text: String(payload?.conversionVarianceReasonText ?? '').trim() || null };
}
