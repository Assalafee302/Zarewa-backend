/** kg/m conversion values: store and display to two decimal places. */

/**
 * @param {number | string | null | undefined} n
 * @returns {number | null}
 */
export function roundConv2(n) {
  if (n == null || n === '' || !Number.isFinite(Number(n)) || Number(n) <= 0) return null;
  return Math.round(Number(n) * 100) / 100;
}

/**
 * @param {number | string | null | undefined} kg
 * @param {number | string | null | undefined} meters
 * @returns {number | null}
 */
export function conversionKgPerMFromMass(kg, meters) {
  const k = Number(kg);
  const m = Number(meters);
  if (!Number.isFinite(k) || !Number.isFinite(m) || k <= 0 || m <= 0) return null;
  return roundConv2(k / m);
}

/**
 * @param {number | string | null | undefined} n
 * @param {{ suffix?: string }} [opts]
 * @returns {string}
 */
export function fmtConv2(n, opts = {}) {
  const v = roundConv2(n);
  if (v == null) return '—';
  const s = v.toFixed(2);
  return opts.suffix ? `${s} ${opts.suffix}` : s;
}

/**
 * Signed % of actual vs a reference kg/m (same formula as production conversion checks).
 * @param {number | string | null | undefined} actual
 * @param {number | string | null | undefined} reference
 * @returns {number | null}
 */
export function conversionVariancePct(actual, reference) {
  const a = Number(actual);
  const r = Number(reference);
  if (!Number.isFinite(a) || a <= 0 || !Number.isFinite(r) || r <= 0) return null;
  return ((a - r) / r) * 100;
}

/**
 * @param {number | null | undefined} pct
 * @param {{ digits?: number }} [opts]
 * @returns {string}
 */
export function formatConversionVariancePct(pct, opts = {}) {
  const digits = opts.digits == null ? 1 : opts.digits;
  if (pct == null || !Number.isFinite(Number(pct))) return '—';
  const n = Number(pct);
  const abs = Math.abs(n).toFixed(digits);
  if (n > 0.05) return `+${abs}%`;
  if (n < -0.05) return `−${abs}%`;
  return `${(0).toFixed(digits)}%`;
}
