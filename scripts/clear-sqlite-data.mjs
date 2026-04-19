#!/usr/bin/env node
/**
 * Deletes all rows from every user table (keeps schema). Stop the API first — SQLite must not be open elsewhere.
 *
 * Usage:
 *   node scripts/clear-sqlite-data.mjs
 *   ZAREWA_DB=C:\\path\\to\\custom.sqlite node scripts/clear-sqlite-data.mjs
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const dbPath = process.env.ZAREWA_DB || path.join(root, 'data', 'zarewa.sqlite');

const db = new Database(dbPath);
db.pragma('foreign_keys = OFF');
const tables = db
  .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
  .all();
for (const { name } of tables) {
  db.exec(`DELETE FROM "${name.replace(/"/g, '""')}"`);
  console.log('cleared', name);
}
try {
  db.exec('DELETE FROM sqlite_sequence');
} catch {
  /* no sequence table */
}
db.pragma('foreign_keys = ON');
db.close();
console.log('all user tables emptied:', dbPath);
