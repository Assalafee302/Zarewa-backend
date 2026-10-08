/**
 * Shared MySQL GET_LOCK naming + failure diagnostics for schema bootstrap and migrations.
 * Holder inspection uses IS_USED_LOCK + processlist so boots log a dead/orphan connection id
 * instead of failing with a silent timeout.
 */

/** Legacy name used before per-database locks. */
export const LEGACY_MIGRATION_LOCK_NAME = 'zarewa_run_migrations';

/** MySQL GET_LOCK names are capped at 64 characters. */
export function migrationLockNameForDatabase(databaseName) {
  const db = String(databaseName || '').trim();
  if (!db) return LEGACY_MIGRATION_LOCK_NAME;
  const raw = `zarewa_mig_${db}`;
  return raw.length <= 64 ? raw : raw.slice(0, 64);
}

/**
 * @param {string} lockName
 * @param {number} waitSec
 * @param {{ holderConnId: number | null, process: object | null }} info
 * @param {'schema' | 'migration'} kind
 */
export function lockAcquireFailureMessage(lockName, waitSec, info, kind = 'migration') {
  const base = `Could not acquire ${kind} lock "${lockName}" within ${waitSec}s.`;
  const holderId = info?.holderConnId;
  if (holderId == null || holderId === undefined) {
    return (
      `${base} IS_USED_LOCK returned no holder (released mid-wait or never held). ` +
        'Stop other Vitest/API processes using this database, then retry.'
    );
  }
  const p = info.process;
  if (!p) {
    return (
      `${base} Holder connection id=${holderId} is NOT in processlist ` +
        `(dead/orphaned connection — MySQL should drop the lock when the session is purged; ` +
        `retry shortly, or KILL ${holderId} / run scripts/diagnose-migration-lock.mjs --kill).`
    );
  }
  const infoSnippet = String(p.info || '-').replace(/\s+/g, ' ').trim().slice(0, 80);
  return (
    `${base} Held by connection id=${p.id} user=${p.user} host=${p.host} ` +
      `db=${p.db || '-'} cmd=${p.command} time=${p.time}s state=${p.state || '-'} info=${infoSnippet}. ` +
      'Stop the old API process before starting a new boot (deploy must not overlap).'
  );
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} lockName
 */
export function inspectLockHolderSync(db, lockName) {
  try {
    const used = db.prepare('SELECT IS_USED_LOCK(?) AS holderConnId').get(lockName);
    const holderConnId =
      used?.holderConnId == null || used?.holderConnId === undefined
        ? null
        : Number(used.holderConnId);
    if (holderConnId == null || !Number.isFinite(holderConnId)) {
      return { holderConnId: null, process: null };
    }
    const process = db
      .prepare(
        `SELECT id, user, host, \`db\`, command, time, state, LEFT(IFNULL(info,''), 120) AS info
         FROM information_schema.processlist WHERE id = ?`
      )
      .get(holderConnId);
    return { holderConnId, process: process || null };
  } catch {
    return { holderConnId: null, process: null };
  }
}

/**
 * @param {{ query: (sql: string, params?: unknown[]) => Promise<[unknown, unknown]> }} conn
 * @param {string} lockName
 */
export async function inspectLockHolderAsync(conn, lockName) {
  try {
    const [usedRows] = await conn.query('SELECT IS_USED_LOCK(?) AS holderConnId', [lockName]);
    const used = /** @type {{ holderConnId?: number | null }[]} */ (usedRows)[0];
    const holderConnId =
      used?.holderConnId == null || used?.holderConnId === undefined
        ? null
        : Number(used.holderConnId);
    if (holderConnId == null || !Number.isFinite(holderConnId)) {
      return { holderConnId: null, process: null };
    }
    const [procRows] = await conn.query(
      `SELECT id, user, host, \`db\`, command, time, state, LEFT(IFNULL(info,''), 120) AS info
       FROM information_schema.processlist WHERE id = ?`,
      [holderConnId]
    );
    const process = /** @type {object[]} */ (procRows)[0] || null;
    return { holderConnId, process };
  } catch {
    return { holderConnId: null, process: null };
  }
}
