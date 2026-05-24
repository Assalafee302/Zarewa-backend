import { migrateMergeDuplicateSuppliers } from './supplierDedupe.js';

/**
 * One-time startup migration: merge duplicate suppliers (company-wide) by name / phone / registry / account.
 * @param {import('better-sqlite3').Database} db
 */
export function migrateMergeDuplicateSuppliersOnBoot(db) {
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='suppliers'`).get()) return;
  const result = migrateMergeDuplicateSuppliers(db);
  if (result.merged > 0) {
    console.info(
      `[migrate] Merged ${result.merged} duplicate supplier record(s):`,
      result.merges.map((m) => `${m.fromId} → ${m.toId}`).join(', ')
    );
  }
}
