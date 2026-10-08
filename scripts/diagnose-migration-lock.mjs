#!/usr/bin/env node
/**
 * Diagnose (and optionally release) a stuck zarewa_mig_<db> / legacy lock.
 * Usage:
 *   node scripts/diagnose-migration-lock.mjs            # inspect only
 *   node scripts/diagnose-migration-lock.mjs --kill     # kill the holder connection
 * Optional: ZAREWA_MYSQL_HOST_OVERRIDE=srv2078.hstgr.io to reach the prod DB from a PC.
 */
import mysql from 'mysql2/promise';
import { loadProjectEnv } from '../server/loadProjectEnv.js';
import { mysqlConfigFromEnv } from '../server/mysqlDatabase.js';
import { migrationLockNameForDatabase, LEGACY_MIGRATION_LOCK_NAME } from '../server/mysqlNamedLock.js';

loadProjectEnv();
const cfg = mysqlConfigFromEnv();
const host = process.env.ZAREWA_MYSQL_HOST_OVERRIDE || cfg.host;
const kill = process.argv.includes('--kill');
const lockName = migrationLockNameForDatabase(cfg.database);
const lockNames = [...new Set([lockName, LEGACY_MIGRATION_LOCK_NAME])];

const c = await mysql.createConnection({
  host,
  port: cfg.port,
  user: cfg.user,
  password: cfg.password,
  database: cfg.database,
  connectTimeout: 15000,
});

console.log(`[lock] host=${host} db=${cfg.database}`);

/** @type {number | null} */
let primaryHolder = null;

for (const name of lockNames) {
  const [[lockRow]] = await c.query(
    `SELECT IS_USED_LOCK(?) AS holderConnId, IS_FREE_LOCK(?) AS isFree`,
    [name, name]
  );
  console.log(
    `[lock] name=${name} free=${lockRow.isFree === 1} holderConnectionId=${lockRow.holderConnId ?? 'none'}`
  );
  if (lockRow.holderConnId != null && primaryHolder == null) {
    primaryHolder = Number(lockRow.holderConnId);
  }
}

const [procs] = await c.query(
  `SELECT id, user, host, db, command, time, state, LEFT(IFNULL(info,''),120) AS info
   FROM information_schema.processlist ORDER BY time DESC`
);
console.log('[processlist]');
let holderAlive = false;
for (const p of procs) {
  const marker = primaryHolder != null && String(p.id) === String(primaryHolder) ? '  <-- HOLDS LOCK' : '';
  if (marker) holderAlive = true;
  console.log(
    `  id=${p.id} user=${p.user} host=${p.host} cmd=${p.command} time=${p.time}s state=${p.state || '-'} info=${p.info || '-'}${marker}`
  );
}

if (primaryHolder != null && !holderAlive) {
  console.log(
    `[lock] holder id=${primaryHolder} is NOT in processlist (dead/orphaned — MySQL should release soon; --kill may still help if the id reappears)`
  );
}

if (primaryHolder != null && kill) {
  console.log(`[kill] killing connection ${primaryHolder}…`);
  await c.query(`KILL ?`, [primaryHolder]);
  for (const name of lockNames) {
    const [[after]] = await c.query(`SELECT IS_FREE_LOCK(?) AS isFree`, [name]);
    console.log(`[kill] ${name} free=${after.isFree === 1}`);
  }
} else if (primaryHolder != null) {
  console.log('[hint] Re-run with --kill to terminate the holder if it is a dead/stuck boot.');
}

await c.end();
