import { runMigrations } from './migrate.js';
import { runHrScheduledJobs } from './hrOps.js';
import { seedEverything } from './seedRun.js';
import { backfillAccountsPayableFromPurchaseOrders } from './writeOps.js';
import { ensureLegacyDemoPack } from './ensureLegacyDemoPack.js';
import { isEmptySeedMode } from './emptySeed.js';
import { legacyDemoPackActive } from './legacyDemoPackPolicy.js';
import { createMysqlDatabase, databaseLabel, mysqlConfigFromEnv } from './mysqlDatabase.js';
import { withDeadlockRetry } from './migrationLock.js';

/** Last boot phase reached (for degraded /api/health and 503 payloads). */
export let lastBootPhase = 'not_started';

function setBootPhase(phase) {
  lastBootPhase = phase;
}

/** Parallel Vitest forks must not share one MySQL schema (concurrent wipe+seed causes flaky failures). */
function resolveVitestTestDatabaseName(base) {
  const poolId = process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID;
  if (poolId == null || String(poolId).trim() === '') return base;
  const suffix = `_w${String(poolId).replace(/\W/g, '')}`;
  const maxLen = 64;
  if (base.length + suffix.length <= maxLen) return `${base}${suffix}`;
  return `${base.slice(0, maxLen - suffix.length)}${suffix}`;
}

function isRetryableBootError(err) {
  const errno = /** @type {{ errno?: number }} */ (err)?.errno;
  const msg = String(err?.message || err);
  return (
    errno === 1213 ||
    errno === 1205 ||
    errno === 1146 ||
    errno === 1824 ||
    /Deadlock found/i.test(msg) ||
    /Lock wait timeout/i.test(msg) ||
    /Failed to open the referenced table/i.test(msg) ||
    /doesn't exist/i.test(msg)
  );
}

function closeQuietly(db) {
  try {
    db?.close();
  } catch {
    /* pool may already be torn down */
  }
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
      const base =
        String(process.env.ZAREWA_MYSQL_TEST_DATABASE || 'zarewa_test').trim() || 'zarewa_test';
      testDbOverride = resolveVitestTestDatabaseName(base);
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

  const attempts = reset ? 4 : 1;
  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    setBootPhase('connecting');

    let db;
    try {
      db = createMysqlDatabase(cfg, { reset });
      setBootPhase('schema_bootstrap_ok');
      db.pragma('foreign_keys = ON');

      setBootPhase('migrations');
      runMigrations(db);
      setBootPhase('migrations_ok');

      try {
        runHrScheduledJobs(db);
      } catch {
        /* optional HR tick */
      }
      if (seed) {
        setBootPhase('seed');
        const runSeed = () => {
          seedEverything(db);
          if (!isEmptySeedMode() && legacyDemoPackActive(db)) ensureLegacyDemoPack(db);
          backfillAccountsPayableFromPurchaseOrders(db);
        };
        if (reset) withDeadlockRetry(runSeed, { attempts: 4 });
        else runSeed();
        setBootPhase('ready');
      }
      return db;
    } catch (e) {
      lastErr = e;
      closeQuietly(db);
      const retry = reset && attempt < attempts && isRetryableBootError(e);
      if (retry) continue;
      if (lastBootPhase === 'connecting' || lastBootPhase === 'schema_bootstrap_ok') {
        setBootPhase('schema_bootstrap_failed');
      }
      if (process.env.NODE_ENV === 'production' && seed && /seed/i.test(lastBootPhase)) {
        console.error('[zarewa] Boot seed failed in production — continuing without seed:', e?.message || e);
        if (db) return db;
      }
      throw e;
    }
  }
  throw lastErr;
}

/** Human-readable DB target for logs (MySQL). */
export function defaultDbPath() {
  return databaseLabel();
}
