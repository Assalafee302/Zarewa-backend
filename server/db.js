import { runMigrations } from './migrate.js';
import { runHrScheduledJobs } from './hrOps.js';
import { seedEverything } from './seedRun.js';
import { backfillAccountsPayableFromPurchaseOrders } from './writeOps.js';
import { ensureLegacyDemoPack } from './ensureLegacyDemoPack.js';
import { isEmptySeedMode } from './emptySeed.js';
import { legacyDemoPackActive } from './legacyDemoPackPolicy.js';
import { createMysqlDatabase, databaseLabel, mysqlConfigFromEnv } from './mysqlDatabase.js';
import { debugBootLog } from './debugBootLog.js';

/** Last boot phase reached (for degraded /api/health and 503 payloads). */
export let lastBootPhase = 'not_started';

function setBootPhase(phase) {
  lastBootPhase = phase;
}

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

  setBootPhase('connecting');
  debugBootLog({
    hypothesisId: 'C',
    location: 'db.js:createDatabase',
    message: 'boot phase start',
    data: { mysqlTarget: `${cfg.host}:${cfg.port}/${cfg.database}`, user: cfg.user, seed, reset },
  });

  let db;
  try {
    db = createMysqlDatabase(cfg, { reset });
    setBootPhase('schema_bootstrap_ok');
    debugBootLog({
      hypothesisId: 'C',
      location: 'db.js:createDatabase',
      message: 'createMysqlDatabase ok',
    });
  } catch (e) {
    setBootPhase('schema_bootstrap_failed');
    debugBootLog({
      hypothesisId: 'C',
      location: 'db.js:createDatabase',
      message: 'createMysqlDatabase failed',
      data: { err: String(e?.message || e), code: e?.code, errno: e?.errno },
    });
    throw e;
  }

  db.pragma('foreign_keys = ON');

  try {
    setBootPhase('migrations');
    debugBootLog({ hypothesisId: 'B', location: 'db.js:runMigrations', message: 'migrations start' });
    runMigrations(db);
    setBootPhase('migrations_ok');
    debugBootLog({ hypothesisId: 'B', location: 'db.js:runMigrations', message: 'migrations ok' });
  } catch (e) {
    setBootPhase('migrations_failed');
    debugBootLog({
      hypothesisId: 'B',
      location: 'db.js:runMigrations',
      message: 'migrations failed',
      data: { err: String(e?.message || e), code: e?.code, errno: e?.errno },
    });
    throw e;
  }

  try {
    runHrScheduledJobs(db);
  } catch {
    /* optional HR tick */
  }
  if (seed) {
    try {
      setBootPhase('seed');
      debugBootLog({ hypothesisId: 'D', location: 'db.js:seed', message: 'seed start' });
      seedEverything(db);
      if (!isEmptySeedMode() && legacyDemoPackActive(db)) ensureLegacyDemoPack(db);
      backfillAccountsPayableFromPurchaseOrders(db);
      setBootPhase('ready');
      debugBootLog({ hypothesisId: 'D', location: 'db.js:seed', message: 'seed ok' });
    } catch (e) {
      setBootPhase('seed_failed');
      debugBootLog({
        hypothesisId: 'D',
        location: 'db.js:seed',
        message: 'seed failed',
        data: { err: String(e?.message || e), code: e?.code, errno: e?.errno },
      });
      throw e;
    }
  }
  debugBootLog({ hypothesisId: 'C', location: 'db.js:createDatabase', message: 'boot phase complete' });
  return db;
}

/** Human-readable DB target for logs (MySQL). */
export function defaultDbPath() {
  return databaseLabel();
}
