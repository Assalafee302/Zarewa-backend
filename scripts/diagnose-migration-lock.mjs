#!/usr/bin/env node
/**
 * Diagnose (and optionally release) a stuck zarewa_run_migrations lock.
 * Usage:
 *   node scripts/diagnose-migration-lock.mjs            # inspect only
 *   node scripts/diagnose-migration-lock.mjs --kill     # kill the holder connection
 * Optional: ZAREWA_MYSQL_HOST_OVERRIDE=srv2078.hstgr.io to reach the prod DB from a PC.
 */
import mysql from 'mysql2/promise';
import { loadProjectEnv } from '../server/loadProjectEnv.js';
import { mysqlConfigFromEnv } from '../server/mysqlDatabase.js';

loadProjectEnv();
const cfg = mysqlConfigFromEnv();
const host = process.env.ZAREWA_MYSQL_HOST_OVERRIDE || cfg.host;
const kill = process.argv.includes('--kill');

const c = await mysql.createConnection({
  host,
  port: cfg.port,
  user: cfg.user,
  password: cfg.password,
  database: cfg.database,
  connectTimeout: 15000,
});

const [[lockRow]] = await c.query(
  `SELECT IS_USED_LOCK('zarewa_run_migrations') AS holderConnId, IS_FREE_LOCK('zarewa_run_migrations') AS isFree`
);
console.log(`[lock] host=${host} db=${cfg.database}`);
console.log(`[lock] free=${lockRow.isFree === 1} holderConnectionId=${lockRow.holderConnId ?? 'none'}`);

const [procs] = await c.query(
  `SELECT id, user, host, db, command, time, state, LEFT(IFNULL(info,''),120) AS info
   FROM information_schema.processlist ORDER BY time DESC`
);
console.log('[processlist]');
for (const p of procs) {
  const marker = String(p.id) === String(lockRow.holderConnId) ? '  <-- HOLDS LOCK' : '';
  console.log(`  id=${p.id} user=${p.user} host=${p.host} cmd=${p.command} time=${p.time}s state=${p.state || '-'} info=${p.info || '-'}${marker}`);
}

if (lockRow.holderConnId && kill) {
  console.log(`[kill] killing connection ${lockRow.holderConnId}…`);
  await c.query(`KILL ?`, [lockRow.holderConnId]);
  const [[after]] = await c.query(`SELECT IS_FREE_LOCK('zarewa_run_migrations') AS isFree`);
  console.log(`[kill] done — lock free=${after.isFree === 1}`);
} else if (lockRow.holderConnId) {
  console.log('[hint] Re-run with --kill to terminate the holder if it is a dead/stuck boot.');
}

await c.end();
