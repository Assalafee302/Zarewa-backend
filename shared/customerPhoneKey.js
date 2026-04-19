/**
 * Customer identity keys for duplicate detection within a branch.
 * Used by server writes and optional client-side checks — keep in sync.
 */

/** Digits-only; last 10 digits when longer (local mobile vs +234). */
export function normalizeCustomerPhoneKey(raw) {
  const d = String(raw ?? '').replace(/\D/g, '');
  if (!d) return '';
  if (d.length >= 10) return d.slice(-10);
  return d;
}

export function normalizeCustomerEmailKey(raw) {
  return String(raw ?? '').trim().toLowerCase();
}
