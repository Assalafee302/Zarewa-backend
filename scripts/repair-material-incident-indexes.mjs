/**
 * One-off repair for shared hosting: drop legacy material_incident indexes that used
 * invalid MySQL prefix keys (e.g. meters_available(64) on REAL).
 * Run from repo root: npm run mysql:repair-material-incidents
 */
import { createDatabase } from '../server/db.js';
import { loadProjectEnv } from '../server/loadProjectEnv.js';
import { mysqlConfigFromEnv } from '../server/mysqlDatabase.js';

loadProjectEnv();
const cfg = mysqlConfigFromEnv();

try {
  const db = createDatabase({ seed: false });
  db.close?.();
  console.log(`[repair] OK — migrations ran on ${cfg.host}:${cfg.port}/${cfg.database}`);
  process.exit(0);
} catch (e) {
  console.error('[repair] FAIL', e?.message || e);
  process.exit(1);
}
