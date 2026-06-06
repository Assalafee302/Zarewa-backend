/**
 * Portable table-existence checks (SQLite + MySQL via mysqlSqlAdapt).
 * @module server/hrTableChecks
 */

const CORE_HR_TABLES = [
  'hr_staff_profiles',
  'hr_requests',
  'hr_payroll_runs',
  'hr_payroll_lines',
  'hr_audit_events',
];

const PHASE6_TABLES = ['hr_beneficiaries', 'hr_incident_memos', 'hr_transfer_recommendations'];

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} tableName
 */
export function hrTableExists(db, tableName) {
  const name = String(tableName || '').trim();
  if (!name) return false;
  try {
    return Boolean(
      db
        .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`)
        .get(name)
    );
  } catch {
    try {
      db.prepare(`SELECT 1 FROM \`${name.replace(/`/g, '')}\` LIMIT 1`).get();
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function hrCoreTablesReady(db) {
  return CORE_HR_TABLES.every((t) => hrTableExists(db, t));
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function hrPhase6BenefitsTablesReady(db) {
  return PHASE6_TABLES.every((t) => hrTableExists(db, t));
}

/**
 * Diagnostic payload for /api/hr/health when module is not ready.
 * @param {import('better-sqlite3').Database} db
 */
export function getHrTableDiagnostics(db) {
  const all = [...CORE_HR_TABLES, ...PHASE6_TABLES];
  const tables = {};
  for (const t of all) {
    tables[t] = hrTableExists(db, t);
  }
  return {
    coreReady: hrCoreTablesReady(db),
    phase6Ready: hrPhase6BenefitsTablesReady(db),
    tables,
    missingCore: CORE_HR_TABLES.filter((t) => !tables[t]),
  };
}
