/**
 * Hostinger / production: skip heavy idempotent seed on every restart so Node listens before proxy timeout.
 * Migrations always run; use ZAREWA_FORCE_BOOT_SEED=1 for a one-off full seed.
 */

export function bootSeedEnabled() {
  const force = String(process.env.ZAREWA_FORCE_BOOT_SEED || '').trim().toLowerCase();
  if (force === '1' || force === 'true' || force === 'yes') return true;

  const skip = String(process.env.ZAREWA_SKIP_BOOT_SEED || '').trim().toLowerCase();
  if (skip === '1' || skip === 'true' || skip === 'yes') return false;

  if (process.env.NODE_ENV === 'production') return false;

  return true;
}
