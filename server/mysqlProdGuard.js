/**
 * Refuse Vitest / wipe paths against Hostinger (and listed) production schemas.
 * Production DB names look like `u172282559_ZAREWA` — never wipe or migrate those from tests.
 */

/** Hostinger shared-hosting schema: u<accountId>_ZAREWA */
const HOSTINGER_PROD_DB_RE = /^u\d+_ZAREWA$/i;

/**
 * @param {string | null | undefined} databaseName
 * @returns {boolean}
 */
export function isProductionMysqlDatabaseName(databaseName) {
  const db = String(databaseName || '').trim();
  if (!db) return false;
  if (HOSTINGER_PROD_DB_RE.test(db)) return true;
  const extra = String(process.env.ZAREWA_MYSQL_PROD_DATABASE_NAMES || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return extra.some((x) => x.toLowerCase() === db.toLowerCase());
}

/**
 * @param {string | null | undefined} databaseName
 * @param {string} [context]
 */
export function assertNotProductionMysqlDatabase(databaseName, context = 'operation') {
  const db = String(databaseName || '').trim();
  if (!isProductionMysqlDatabaseName(db)) return;
  throw new Error(
    `Refusing ${context}: MySQL database "${db}" matches production. ` +
      'Use a local/test schema (e.g. zarewa_test) — never point Vitest or wipe scripts at production .env.'
  );
}

/**
 * Vitest / scripts: fail fast if any configured MySQL database name is production.
 * Call after env is loaded.
 */
export function assertVitestNotUsingProductionMysql() {
  const checked = [
    ['ZAREWA_MYSQL_DATABASE', process.env.ZAREWA_MYSQL_DATABASE],
    ['ZAREWA_MYSQL_TEST_DATABASE', process.env.ZAREWA_MYSQL_TEST_DATABASE],
    ['ZAREWA_MYSQL_E2E_DATABASE', process.env.ZAREWA_MYSQL_E2E_DATABASE],
  ];
  for (const [key, value] of checked) {
    if (!value || !String(value).trim()) continue;
    if (isProductionMysqlDatabaseName(value)) {
      throw new Error(
        `Refusing to run Vitest: ${key}="${String(value).trim()}" matches production. ` +
          'Do not load the production .env for tests — use scripts/vitest-local-xampp.mjs or set ZAREWA_MYSQL_* to a non-prod database.'
      );
    }
  }
}
