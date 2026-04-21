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
 *   PRUNE_DRY_RUN=true|false
 *   ZAREWA_MYSQL_DATABASE=... (optional override; otherwise from .env)
 */

import { openConfiguredMysql } from '../server/cliMysql.js';

const RETAIN_DAYS = Math.max(7, Number(process.env.RETAIN_DAYS || 365));
const DRY_RUN = String(process.env.PRUNE_DRY_RUN || 'true').toLowerCase() !== 'false';

function isoDateDaysAgo(days) {
  const dt = new Date();
  dt.setDate(dt.getDate() - days);
  return dt.toISOString().slice(0, 10);
}

const cutoffDateIso = isoDateDaysAgo(RETAIN_DAYS);

const { db, label } = openConfiguredMysql({ migrate: true });
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
  () => pruneTable('audit_log', 'occurred_at_iso'),
  () => pruneTable('production_conversion_checks', 'at_iso'),
  () => pruneTable('treasury_movements', 'posted_at_iso'),
];

const results = [];
db.transaction(() => {
  for (const fn of plan) results.push(fn());
})();

console.log(
  JSON.stringify(
    {
      db: label(),
      dryRun: DRY_RUN,
      retainDays: RETAIN_DAYS,
      cutoffDateIso,
      results,
      note: DRY_RUN ? 'Dry run only. Set PRUNE_DRY_RUN=false to delete.' : 'Deletion completed.',
    },
    null,
    2
  )
);

db.close();
