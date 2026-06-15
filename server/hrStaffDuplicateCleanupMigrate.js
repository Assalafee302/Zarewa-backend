import { mergeAllDuplicateHrStaffByEmployeeNo } from './hrStaffDuplicateCleanup.js';
import { hrTableExists } from './hrTableChecks.js';

/**
 * Startup migration: one employee number → one login user.
 * @param {import('better-sqlite3').Database} db
 */
export function migrateMergeDuplicateHrStaffOnBoot(db) {
  if (!hrTableExists(db, 'hr_staff_profiles')) return;
  const result = mergeAllDuplicateHrStaffByEmployeeNo(db);
  if (!result.ok) return;
  if (result.merged > 0) {
    console.info(
      `[migrate] Merged ${result.merged} duplicate staff login(s) by employee number:`,
      result.merges.map((m) => `${m.fromUsername} → ${m.toUsername} (emp ${m.employeeNo})`).join(', ')
    );
  }
}
