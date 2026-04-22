#!/usr/bin/env node
/**
 * Drops all tables in the configured MySQL database (default from env: zarewa_db).
 * Stop the API first to avoid connection errors mid-wipe.
 */
import mysql from 'mysql2/promise';
import { mysqlConfigFromEnv, databaseLabel } from '../server/mysqlDatabase.js';

const cfg = mysqlConfigFromEnv();
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
  console.log(`Wiped all tables in ${databaseLabel(cfg)}`);
} finally {
  await conn.end();
}
