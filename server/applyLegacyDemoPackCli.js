/**
 * Apply the legacy demo pack (NDA / QT-2026-027 / CL-2026-1592 / RC-2026-1849) to the SQLite file.
 * Use when the API was not restarted after adding ensureLegacyDemoPack, or ZAREWA_DB points elsewhere.
 *
 * Usage: npm run db:legacy-demo
 *        set ZAREWA_DB=C:\path\to\file.sqlite && npm run db:legacy-demo
 */
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { runMigrations } from './migrate.js';
import { ensureLegacyDemoPack } from './ensureLegacyDemoPack.js';
import { defaultDbPath } from './db.js';

const dbPath = process.env.ZAREWA_DB || defaultDbPath();

if (!fs.existsSync(dbPath)) {
  console.error(`[zarewa] Database file not found: ${dbPath}`);
  process.exit(1);
}

const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
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

console.log('[zarewa] Refresh the browser (or sign out/in) so Sales reloads bootstrap data.');
