/**
 * Canonical roofing profile names for analytics (Metra and Industrial 6 are one longspan family).
 * @param {string} profile
 * @returns {string}
 */
export function normalizeMaterialProfile(profile) {
  const raw = String(profile || '').trim();
  if (!raw || raw === '—') return '—';

  const lower = raw.toLowerCase();
  const compact = lower.replace(/[^a-z0-9]/g, '');

  const isLongspanIndusMetra =
    compact.includes('metra') ||
    compact.includes('metral') ||
    compact.includes('indus6') ||
    compact.includes('industrial6') ||
    compact.includes('industrialsix') ||
    (lower.includes('longspan') && (lower.includes('metra') || lower.includes('indus')));

  if (isLongspanIndusMetra) {
    return 'Longspan (Industrial 6 & Metra)';
  }

  return raw;
}
