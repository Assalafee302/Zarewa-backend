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

/**
 * Last four numeric digits for dense registers (QT-2026-0042 → 0042, C-ALU-0123 → 0123).
 * @param {string|null|undefined} ref
 */
export function displayLast4(ref) {
  const s = String(ref ?? '').trim();
  if (!s || s === '—') return s === '—' ? '—' : '';
  const digits = s.replace(/\D/g, '');
  if (digits.length >= 4) return digits.slice(-4);
  if (digits.length > 0) return digits.padStart(4, '0');
  return s.length <= 4 ? s : s.slice(-4);
}

/**
 * Short calendar date for transaction registers (2026-05-30 → 30/05).
 * @param {string|null|undefined} iso
 */
export function displayTxnDateShort(iso) {
  const d = String(iso ?? '').slice(0, 10);
  if (!d || d.length < 10) return d || '—';
  const [, m, day] = d.split('-');
  return `${day}/${m}`;
}
