/**
 * Format NGN for desk / print UI.
 * Invalid / empty → em dash. Always en-NG integer naira (no ₦NaN).
 * @param {unknown} n
 * @returns {string}
 */
export function formatNgn(n) {
  if (n == null || n === '') return '—';
  const num = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(num)) return '—';
  return `₦${Math.round(num).toLocaleString('en-NG')}`;
}
