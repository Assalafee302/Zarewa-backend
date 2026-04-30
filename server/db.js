import { runMigrations } from './migrate.js';
import { runHrScheduledJobs } from './hrOps.js';
import { seedEverything } from './seedRun.js';
import { backfillAccountsPayableFromPurchaseOrders } from './writeOps.js';
import { ensureLegacyDemoPack } from './ensureLegacyDemoPack.js';
import { isEmptySeedMode } from './emptySeed.js';
import { createMysqlDatabase, databaseLabel, mysqlConfigFromEnv } from './mysqlDatabase.js';

/**
 * @param {{ seed?: boolean; reset?: boolean } | string} [pathOrOpts]
 *   Pass `':memory:'` for Vitest — uses `ZAREWA_MYSQL_TEST_DATABASE` (default `zarewa_test`) and wipes first.
 *   seed=false — schema + migrations only (CLI migrate).
 *   reset=true — drop all tables in the target DB first.
 */
export function createDatabase(pathOrOpts = {}, maybeOpts) {
  let opts = { seed: true, reset: false };
  let testDbOverride = null;

  if (typeof pathOrOpts === 'string') {
    if (pathOrOpts === ':memory:') {
      testDbOverride =
        String(process.env.ZAREWA_MYSQL_TEST_DATABASE || 'zarewa_test').trim() || 'zarewa_test';
      opts.reset = true;
      if (typeof maybeOpts === 'object' && maybeOpts) Object.assign(opts, maybeOpts);
    }
  } else if (pathOrOpts && typeof pathOrOpts === 'object') {
    Object.assign(opts, pathOrOpts);
  }

  const seed = opts.seed !== false;
  const reset = Boolean(opts.reset);
  const cfg = mysqlConfigFromEnv();
  if (testDbOverride) cfg.database = testDbOverride;
  else if (opts.database) cfg.database = String(opts.database);

  const db = createMysqlDatabase(cfg, { reset });
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  try {
    runHrScheduledJobs(db);
  } catch {
    /* optional HR tick */
  }
  if (seed) {
    seedEverything(db);
    if (!isEmptySeedMode()) ensureLegacyDemoPack(db);
    backfillAccountsPayableFromPurchaseOrders(db);
  }
  return db;
}

/** Human-readable DB target for logs (MySQL). */
export function defaultDbPath() {
  return databaseLabel();
}
