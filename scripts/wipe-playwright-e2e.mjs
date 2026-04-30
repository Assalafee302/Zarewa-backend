/**
 * Drops all tables in the Playwright E2E MySQL database (default zarewa_e2e).
 * The Playwright server also resets this DB on startup; this script is optional cleanup.
 */
import mysql from 'mysql2/promise';
import { mysqlConfigFromEnv, databaseLabel } from '../server/mysqlDatabase.js';

const cfg = mysqlConfigFromEnv();
cfg.database = String(process.env.ZAREWA_MYSQL_E2E_DATABASE || 'zarewa_e2e').trim() || 'zarewa_e2e';

const conn = await mysql.createConnection({
  host: cfg.host,
  port: cfg.port,
  user: cfg.user,
  password: cfg.password,
  database: cfg.database,
  multipleStatements: true,
});
try {
  await conn.query('SET FOREIGN_KEY_CHECKS = 0');
  const [rows] = await conn.query(
    "SELECT TABLE_NAME AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'"
  );
  for (const { n } of rows) {
    await conn.query(`DROP TABLE IF EXISTS \`${String(n).replace(/`/g, '')}\``);
  }
  await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  console.log(`[wipe-playwright-e2e] Wiped ${databaseLabel(cfg)}`);
} finally {
  await conn.end();
}
