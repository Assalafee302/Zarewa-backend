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

const PHASE8_TABLES = ['hr_settings', 'hr_staff_import_runs', 'hr_employee_number_history'];

const PHASE9_TABLES = [
  'hr_executive_beneficiaries',
  'hr_executive_stipends',
  'hr_domestic_staff_profiles',
  'hr_executive_payments',
  'hr_executive_payment_exports',
];

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
 * @param {import('better-sqlite3').Database} db
 */
export function hrPhase8OperationalTablesReady(db) {
  return PHASE8_TABLES.every((t) => hrTableExists(db, t));
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function hrPhase9ExecutiveBenefitsTablesReady(db) {
  return PHASE9_TABLES.every((t) => hrTableExists(db, t));
}

/**
 * Diagnostic payload for /api/hr/health when module is not ready.
 * @param {import('better-sqlite3').Database} db
 */
export function getHrTableDiagnostics(db) {
  const all = [...CORE_HR_TABLES, ...PHASE6_TABLES, ...PHASE8_TABLES, ...PHASE9_TABLES];
  const tables = {};
  for (const t of all) {
    tables[t] = hrTableExists(db, t);
  }
  return {
    coreReady: hrCoreTablesReady(db),
    phase6Ready: hrPhase6BenefitsTablesReady(db),
    phase8Ready: hrPhase8OperationalTablesReady(db),
    phase9Ready: hrPhase9ExecutiveBenefitsTablesReady(db),
    tables,
    missingCore: CORE_HR_TABLES.filter((t) => !tables[t]),
    missingPhase8: PHASE8_TABLES.filter((t) => !tables[t]),
    missingPhase9: PHASE9_TABLES.filter((t) => !tables[t]),
  };
}
