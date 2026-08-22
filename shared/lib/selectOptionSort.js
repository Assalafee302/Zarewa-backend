/**
 * Default string compare for select labels (case-insensitive, numeric segments).
 * Frontend copies via `npm run sync:shared` → src/shared/lib/selectOptionSort.js
 */
const LOCALE_OPTS = /** @type {const} */ ({ sensitivity: 'base', numeric: true });

/**
 * Numeric-aware gauge ordering (e.g. 0.40mm before 0.45mm), then locale tie-break.
 * @param {string} a
 * @param {string} b
 */
export function compareGaugeLabels(a, b) {
  const na = parseFloat(String(a).replace(/[^\d.]/g, '')) || 0;
  const nb = parseFloat(String(b).replace(/[^\d.]/g, '')) || 0;
  if (na !== nb) return na - nb;
  return String(a).localeCompare(String(b), undefined, LOCALE_OPTS);
}

/**
 * Alphabetical ordering for arbitrary option text (product names, colours, banks, etc.).
 * @param {string} a
 * @param {string} b
 */
export function compareSelectLabels(a, b) {
  return String(a ?? '').localeCompare(String(b ?? ''), undefined, LOCALE_OPTS);
}
