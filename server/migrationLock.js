import { mysqlSyncTimeoutMs } from './mysqlDatabase.js';

const MIGRATION_LOCK_NAME = 'zarewa_run_migrations';

/** MySQL GET_LOCK names are capped at 64 characters. */
export function migrationLockNameForDatabase(databaseName) {
  const db = String(databaseName || '').trim();
  if (!db) return MIGRATION_LOCK_NAME;
  const raw = `zarewa_mig_${db}`;
  return raw.length <= 64 ? raw : raw.slice(0, 64);
}

function resolveMigrationLockName(db) {
  try {
    const row = db.prepare('SELECT DATABASE() AS n').get();
    return migrationLockNameForDatabase(row?.n);
  } catch {
    return MIGRATION_LOCK_NAME;
  }
}

/** Remote / production boots can take 15+ minutes; keep tests fast-fail at 120s. */
export function defaultMigrationLockWaitSec() {
  if (process.env.NODE_ENV === 'test' || process.env.VITEST === 'true') return 120;
  return 1200;
}

function migrationLockWaitSec() {
  const fromEnv = Number(process.env.ZAREWA_MIGRATION_LOCK_WAIT_SEC);
  if (Number.isFinite(fromEnv) && fromEnv > 0) return fromEnv;
  return defaultMigrationLockWaitSec();
}

function isDeadlockError(err) {
  const errno = /** @type {{ errno?: number }} */ (err).errno;
  const code = /** @type {{ code?: string }} */ (err).code;
  return errno === 1213 || code === 'ER_LOCK_DEADLOCK';
}

/**
 * Retry a sync DB call when InnoDB reports a deadlock (common when two boots migrate at once).
 * @template T
 * @param {() => T} fn
 * @param {{ attempts?: number }} [opts]
 */
export function withDeadlockRetry(fn, opts = {}) {
  const attempts = Math.max(Number(opts.attempts) || 4, 1);
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return fn();
    } catch (e) {
      lastErr = e;
      if (!isDeadlockError(e) || i >= attempts) throw e;
    }
  }
  throw lastErr;
}

/**
 * GET_LOCK blocks server-side for the entire wait it is given, but every query still
 * travels the synckit channel, which gives up after ZAREWA_MYSQL_SYNC_TIMEOUT_MS (10s
 * when serving). Asking for a 1200s lock in one call therefore kills the worker rather
 * than queueing it — precisely what happens when several workers boot together and one
 * of them is migrating. So wait in slices that fit inside the sync timeout, re-asking
 * until the overall deadline.
 * @param {number} totalWaitSec
 */
function lockSliceSec(totalWaitSec) {
  const budgetSec = Math.floor(mysqlSyncTimeoutMs() / 1000);
  const slice = Math.max(1, Math.floor(budgetSec / 2));
  return Math.max(1, Math.min(totalWaitSec, slice));
}

/**
 * Blocking sleep. Boot is single-threaded and not yet serving, so parking the thread is
 * fine here — and it is the only way to back off between attempts in this sync codebase.
 * @param {number} ms
 */
function sleepSync(ms) {
  if (!(ms > 0)) return;
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      /* SharedArrayBuffer unavailable — spin as a last resort */
    }
  }
}

/**
 * Serialize boot migrations across concurrent API processes on the same MySQL database.
 * @param {import('better-sqlite3').Database} db
 * @param {() => void} fn
 */
export function withMigrationLock(db, fn) {
  let acquired = false;
  const lockName = resolveMigrationLockName(db);
  try {
    const totalWaitSec = migrationLockWaitSec();
    const sliceSec = lockSliceSec(totalWaitSec);
    const startedAt = Date.now();
    const deadline = startedAt + totalWaitSec * 1000;
    let lastLoggedAt = startedAt;

    for (;;) {
      const attemptedAt = Date.now();
      const row = db.prepare(`SELECT GET_LOCK(?, ?) AS got`).get(lockName, sliceSec);
      acquired = Number(row?.got) === 1;
      if (acquired || Date.now() >= deadline) break;

      // GET_LOCK is expected to block for the whole slice. If it came back immediately
      // it is not really waiting (error, or NULL), so back off rather than hammer MySQL.
      const elapsedMs = Date.now() - attemptedAt;
      if (elapsedMs < 250) sleepSync(Math.min(1000, Math.max(0, deadline - Date.now())));

      const now = Date.now();
      if (now - lastLoggedAt >= 30_000) {
        lastLoggedAt = now;
        console.warn(
          `[zarewa] waiting for migration lock "${lockName}" — another instance is migrating ` +
            `(${Math.round((now - startedAt) / 1000)}s of ${totalWaitSec}s)`
        );
      }
    }

    if (!acquired) {
      throw new Error(
        `Could not acquire migration lock "${lockName}" within ${totalWaitSec}s. ` +
          'Another Zarewa process may be migrating the same database — wait and retry, or stop duplicate instances.'
      );
    }
    return withDeadlockRetry(fn);
  } finally {
    if (acquired) {
      try {
        db.prepare(`SELECT RELEASE_LOCK(?)`).run(lockName);
      } catch {
        /* lock may already be released on connection drop */
      }
    }
  }
}
