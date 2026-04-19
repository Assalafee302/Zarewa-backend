import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from './schemaSql.js';
import { runMigrations } from './migrate.js';
import { runHrScheduledJobs } from './hrOps.js';
import { seedEverything } from './seedRun.js';
import { backfillAccountsPayableFromPurchaseOrders } from './writeOps.js';
import { ensureLegacyDemoPack } from './ensureLegacyDemoPack.js';
import { isEmptySeedMode } from './emptySeed.js';

/**
 * @param {string} dbPath File path or ':memory:'
 */
export function createDatabase(dbPath) {
  if (dbPath !== ':memory:') {
    const dir = path.dirname(path.resolve(dbPath));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  runMigrations(db);
  try {
    runHrScheduledJobs(db);
  } catch {
    /* optional HR tick */
  }
  seedEverything(db);
  if (!isEmptySeedMode()) ensureLegacyDemoPack(db);
  backfillAccountsPayableFromPurchaseOrders(db);
  return db;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Default file DB at project `data/zarewa.sqlite`.
 * Resolved from this file’s location (server/) so imports and the API hit the same DB even when
 * `process.cwd()` differs (e.g. running a script from another directory).
 */
export function defaultDbPath() {
  return path.join(__dirname, '..', 'data', 'zarewa.sqlite');
}
