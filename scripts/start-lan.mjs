/**
 * Start API bound to all interfaces so other devices on the same LAN can reach it
 * (e.g. phone testing). Uses ZAREWA_LISTEN_HOST if already set.
 */
if (!String(process.env.ZAREWA_LISTEN_HOST || '').trim()) {
  process.env.ZAREWA_LISTEN_HOST = '0.0.0.0';
}
await import('../server/index.js');
