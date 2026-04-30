/**
 * Apply the legacy demo pack (NDA / QT-2026-027 / CL-2026-1592 / RC-2026-1849) to the configured MySQL DB.
 *
 * Usage: npm run db:legacy-demo
 */
import { createMysqlDatabase, databaseLabel, mysqlConfigFromEnv } from './mysqlDatabase.js';
import { runMigrations } from './migrate.js';
import { ensureLegacyDemoPack } from './ensureLegacyDemoPack.js';

const cfg = mysqlConfigFromEnv();
const db = createMysqlDatabase(cfg, { reset: false });
db.pragma('foreign_keys = ON');
runMigrations(db);
ensureLegacyDemoPack(db);

const row = db.prepare('SELECT id, quotation_ref, date_iso FROM cutting_lists WHERE id = ?').get('CL-2026-1592');
db.close();

if (row) {
  console.log(`[zarewa] Verified cutting list in DB: ${row.id} · ${row.quotation_ref} · ${row.date_iso}`);
} else {
  console.warn('[zarewa] Cutting list CL-2026-1592 still missing — check server logs for errors.');
}

console.log(`[zarewa] DB: ${databaseLabel(cfg)}`);
console.log('[zarewa] Refresh the browser (or sign out/in) so Sales reloads bootstrap data.');
