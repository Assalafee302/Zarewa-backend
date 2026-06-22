const MIGRATION_LOCK_NAME = 'zarewa_run_migrations';
const MIGRATION_LOCK_WAIT_SEC =
  Number(process.env.ZAREWA_MIGRATION_LOCK_WAIT_SEC || 120) || 120;

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
 * Serialize boot migrations across concurrent API processes on the same MySQL database.
 * @param {import('better-sqlite3').Database} db
 * @param {() => void} fn
 */
export function withMigrationLock(db, fn) {
  let acquired = false;
  try {
    const row = db.prepare(`SELECT GET_LOCK(?, ?) AS got`).get(MIGRATION_LOCK_NAME, MIGRATION_LOCK_WAIT_SEC);
    acquired = Number(row?.got) === 1;
    if (!acquired) {
      throw new Error(
        `Could not acquire migration lock "${MIGRATION_LOCK_NAME}" within ${MIGRATION_LOCK_WAIT_SEC}s. ` +
          'Another Zarewa process may be migrating the same database — wait and retry, or stop duplicate instances.'
      );
    }
    return withDeadlockRetry(fn);
  } finally {
    if (acquired) {
      try {
        db.prepare(`SELECT RELEASE_LOCK(?)`).run(MIGRATION_LOCK_NAME);
      } catch {
        /* lock may already be released on connection drop */
      }
    }
  }
}
