import { tableHasColumn } from './schemaCache.js';

/**
 * Shared branch filtering for SQL (SQLite).
 * @param {import('better-sqlite3').Database} db
 * @param {string} table
 * @param {'ALL' | string} scope
 * @param {string} [alias] Table alias (e.g. j for production_jobs j)
 */
export function branchPredicate(db, table, scope, alias) {
  if (scope === 'ALL' || !scope) {
    return { sql: '', args: [] };
  }
  if (!tableHasColumn(db, table, 'branch_id')) return { sql: '', args: [] };
  const col = alias ? `${alias}.branch_id` : 'branch_id';
  /* NULL branch_id is backfilled to default in dbIntegrityMigrate — strict match only. */
  return { sql: ` AND ${col} = ?`, args: [scope] };
}
