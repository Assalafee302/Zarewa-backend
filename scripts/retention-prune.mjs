/**
 * Retention / pruning helper for large tables.
 *
 * Default is DRY RUN.
 *
 * Usage:
 *   node scripts/retention-prune.mjs
 *
 * Env:
 *   RETAIN_DAYS=365
 *   DB_PATH=./data/zarewa.sqlite
 *   PRUNE_DRY_RUN=true|false
 */

import path from 'node:path';
import Database from 'better-sqlite3';

const RETAIN_DAYS = Math.max(7, Number(process.env.RETAIN_DAYS || 365));
const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'zarewa.sqlite');
const DRY_RUN = String(process.env.PRUNE_DRY_RUN || 'true').toLowerCase() !== 'false';

function isoDateDaysAgo(days) {
  const dt = new Date();
  dt.setDate(dt.getDate() - days);
  return dt.toISOString().slice(0, 10);
}

const cutoffDateIso = isoDateDaysAgo(RETAIN_DAYS);

const db = new Database(DB_PATH);
db.pragma('foreign_keys = ON');

function tableExists(name) {
  return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(name));
}

function pruneTable(table, dateColumn, extraWhere = '') {
  if (!tableExists(table)) return { table, skipped: true, deleted: 0 };
  const where = `WHERE ${dateColumn} < ? ${extraWhere ? `AND (${extraWhere})` : ''}`;
  const countRow = db.prepare(`SELECT COUNT(*) AS c FROM ${table} ${where}`).get(cutoffDateIso);
  const toDelete = Number(countRow?.c) || 0;
  if (DRY_RUN || toDelete === 0) return { table, skipped: false, deleted: 0, wouldDelete: toDelete };
  const r = db.prepare(`DELETE FROM ${table} ${where}`).run(cutoffDateIso);
  return { table, skipped: false, deleted: r.changes || 0 };
}

const plan = [
  // Audit log can grow quickly; keep a year by default.
  () => pruneTable('audit_log', 'occurred_at_iso'),
  // Production conversion checks can explode; keep a year by default.
  () => pruneTable('production_conversion_checks', 'at_iso'),
  // Treasury movements are important; you may prefer longer retention.
  () => pruneTable('treasury_movements', 'at_iso'),
];

const results = [];
db.transaction(() => {
  for (const fn of plan) results.push(fn());
})();

console.log(
  JSON.stringify(
    {
      dbPath: DB_PATH,
      dryRun: DRY_RUN,
      retainDays: RETAIN_DAYS,
      cutoffDateIso,
      results,
      note: DRY_RUN
        ? 'Dry run only. Set PRUNE_DRY_RUN=false to delete.'
        : 'Deletion completed. Consider running VACUUM during maintenance windows.',
    },
    null,
    2
  )
);

db.close();

