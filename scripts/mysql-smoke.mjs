/**
 * Quick TCP + auth check for the MySQL target in .env (same vars as the API).
 * Run from repo root: npm run mysql:smoke
 */
import mysql from 'mysql2/promise';
import { loadProjectEnv } from '../server/loadProjectEnv.js';
import { mysqlConfigFromEnv } from '../server/mysqlDatabase.js';

loadProjectEnv();
const cfg = mysqlConfigFromEnv();
const label = `${cfg.host}:${cfg.port}/${cfg.database}`;

try {
  const c = await mysql.createConnection({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
  });
  await c.ping();
  await c.end();
  console.log(`[mysql:smoke] OK — connected to ${label} as ${cfg.user}`);
  process.exit(0);
} catch (e) {
  const msg = e?.sqlMessage || e?.message || String(e);
  console.error(`[mysql:smoke] FAIL — ${label} (${cfg.user})`);
  console.error(`[mysql:smoke] ${msg}`);
  console.error('[mysql:smoke] Fix: start MySQL / MariaDB, create the database if needed, then set ZAREWA_MYSQL_* in .env (see .env.example).');
  process.exit(1);
}
