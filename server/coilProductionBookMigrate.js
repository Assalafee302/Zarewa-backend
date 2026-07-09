import {
  listCoilProductionBookReconciliationIssues,
  recalculateAllCoilProductionJobStock,
} from './productionTraceability.js';

const MIGRATION_ID = 'coil-production-book-repair-2026-v1';

/** @param {import('better-sqlite3').Database} db */
function schemaMigrationDone(db, migrationId) {
  try {
    return Boolean(
      db.prepare(`SELECT 1 FROM zarewa_schema_migrations WHERE migration_id = ?`).get(migrationId)
    );
  } catch {
    return false;
  }
}

/** @param {import('better-sqlite3').Database} db */
function markSchemaMigrationDone(db, migrationId) {
  db.prepare(`REPLACE INTO zarewa_schema_migrations (migration_id, applied_at_iso) VALUES (?, ?)`).run(
    migrationId,
    new Date().toISOString()
  );
}

/**
 * One-time repair: sync job consumed kg from opening−closing and rebuild coil on-hand
 * for coils where production allocations drifted from the coil book.
 * @param {import('better-sqlite3').Database} db
 */
export function migrateRepairCoilProductionBookDrift2026(db) {
  if (schemaMigrationDone(db, MIGRATION_ID)) return { skipped: true, repaired: 0 };
  const hasPjc = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='production_job_coils'`).get();
  const hasCoils = db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='coil_lots'`).get();
  if (!hasPjc || !hasCoils) {
    markSchemaMigrationDone(db, MIGRATION_ID);
    return { skipped: true, repaired: 0 };
  }

  const issues = listCoilProductionBookReconciliationIssues(db, { minGapKg: 0.05 });
  let repaired = 0;
  const failures = [];
  for (const issue of issues) {
    const cn = String(issue.coilNo ?? '').trim();
    if (!cn) continue;
    try {
      const r = recalculateAllCoilProductionJobStock(db, cn, {});
      if (r.ok) repaired += 1;
      else failures.push({ coilNo: cn, error: r.error });
    } catch (e) {
      failures.push({ coilNo: cn, error: String(e?.message || e) });
    }
  }

  markSchemaMigrationDone(db, MIGRATION_ID);
  if (issues.length) {
    console.log(
      `[migrate] coil production book repair: ${repaired}/${issues.length} coil(s) recalculated` +
        (failures.length ? ` (${failures.length} failed)` : '')
    );
  }
  return { skipped: false, issueCount: issues.length, repaired, failures };
}
