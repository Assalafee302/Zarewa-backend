/**
 * Read-only finance profile CLI (SELECT only).
 *   node scripts/finance-live-profile-readonly.mjs > finance-profile.json
 */
import { runFinanceLiveProfileFromEnv } from '../server/financeLiveProfileReadonly.js';

try {
  const out = await runFinanceLiveProfileFromEnv();
  console.log(JSON.stringify(out, null, 2));
} catch (e) {
  console.error(JSON.stringify({ ok: false, error: String(e?.message || e) }));
  process.exit(1);
}
