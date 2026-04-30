/**
 * Non-blocking warnings for dates that may need extra scrutiny (backdating).
 */

/**
 * @param {string | null | undefined} isoDate - YYYY-MM-DD or ISO datetime prefix
 * @param {string} [fieldLabel]
 * @returns {string | null}
 */
export function backdateWarningForActedDate(isoDate, fieldLabel = 'Effective date') {
  const raw = String(isoDate || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const today = new Date().toISOString().slice(0, 10);
  if (raw < today) {
    return `${fieldLabel} (${raw}) is before today — confirm period, authority, and audit trail.`;
  }
  return null;
}
