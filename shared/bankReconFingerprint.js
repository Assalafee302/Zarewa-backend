/**
 * Stable fingerprint for bank import rows (branch + date + normalized description + amount).
 * Used server-side for duplicate skipping and client-side for previews.
 */
export function bankReconImportFingerprint({ bankDateISO, description, amountNgn, branchId }) {
  const d = String(bankDateISO || '').slice(0, 10);
  const desc = String(description || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
  const amt = Math.round(Number(amountNgn) || 0);
  const b = String(branchId || '').trim();
  return `${b}|${d}|${desc}|${amt}`;
}
