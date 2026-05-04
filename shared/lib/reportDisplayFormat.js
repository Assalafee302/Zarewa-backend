/**
 * Compact document references for dense reports (print / Excel).
 * Strips one leading type prefix (e.g. QT-2026-001 → 2026-001).
 */

const DOC_PREFIX = /^([A-Z]{2,8})-(.+)$/i;

/**
 * @param {string|null|undefined} ref
 * @returns {string} Compact display token; empty input → ''.
 */
export function displayDocNumber(ref) {
  const s = String(ref ?? '').trim();
  if (!s || s === '—') return s === '—' ? '—' : '';
  const m = s.match(DOC_PREFIX);
  if (m && m[2]) return String(m[2]).trim();
  return s;
}

/**
 * Coil numbers may carry a type prefix in some imports.
 * @param {string|null|undefined} coilNo
 * @returns {string}
 */
export function displayCoilNumber(coilNo) {
  return displayDocNumber(coilNo) || String(coilNo ?? '').trim() || '—';
}
