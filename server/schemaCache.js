/**
 * Process-wide cache for schema-shape probes (`PRAGMA table_info`, `sqlite_master`).
 *
 * Under MySQL every one of these probes costs a full synckit worker round trip
 * *plus* an INFORMATION_SCHEMA query, and hot paths re-ask the same question on
 * every request (branch filtering, auth column checks, HR table readiness).
 * The shape only changes when migrations run, so memoise it and reset explicitly.
 *
 * @module server/schemaCache
 */

/** @type {Map<string, boolean>} `${table}:${column}` → column exists */
const columnCache = new Map();
/** @type {Map<string, boolean>} table → table exists */
const tableCache = new Map();

/** Drop every memoised probe. Call after migrations or a test schema reset. */
export function resetSchemaCache() {
  columnCache.clear();
  tableCache.clear();
}

/**
 * Does `table` have `column`? Memoised; failures cache as `false` (matching the
 * existing inline try/catch probes this replaces).
 * @param {import('better-sqlite3').Database} db
 * @param {string} table
 * @param {string} column
 */
export function tableHasColumn(db, table, column) {
  const key = `${table}:${column}`;
  const hit = columnCache.get(key);
  if (hit !== undefined) return hit;
  let exists = false;
  try {
    exists = db
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .some((c) => c.name === column);
  } catch {
    exists = false;
  }
  columnCache.set(key, exists);
  return exists;
}

/**
 * Does `table` exist? Memoised.
 * @param {import('better-sqlite3').Database} db
 * @param {string} table
 */
export function tableExists(db, table) {
  const name = String(table || '').trim();
  if (!name) return false;
  const hit = tableCache.get(name);
  if (hit !== undefined) return hit;
  let exists = false;
  try {
    exists = Boolean(
      db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name)
    );
  } catch {
    /* Adapter could not map the probe — fall back to touching the table itself. */
    try {
      db.prepare(`SELECT 1 FROM \`${name.replace(/`/g, '')}\` LIMIT 1`).get();
      exists = true;
    } catch {
      exists = false;
    }
  }
  tableCache.set(name, exists);
  return exists;
}
