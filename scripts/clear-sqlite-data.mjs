#!/usr/bin/env node
/**
 * Deletes all rows from every user table (keeps schema). Stop the API first.
 *
 * Usage:
 *   node scripts/clear-sqlite-data.mjs
 */
import { openConfiguredMysql } from '../server/cliMysql.js';

const { db, label } = openConfiguredMysql({ migrate: false });
db.pragma('foreign_keys = OFF');
const tables = db
  .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
  .all();
for (const { name } of tables) {
  const n = String(name).replace(/`/g, '');
  db.exec(`DELETE FROM \`${n}\``);
  console.log('cleared', n);
}
db.pragma('foreign_keys = ON');
db.close();
console.log('all user tables emptied:', label());
