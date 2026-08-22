#!/usr/bin/env node
/**
 * Reset Vitest MySQL worker databases and release migration lock.
 * Run before integration suites when a prior run was killed mid-migrate.
 * Prefers mysql2 (same credentials as the API); falls back to mysql CLI.
 */
import { spawnSync } from 'node:child_process';
import mysql from 'mysql2/promise';
import { loadProjectEnv } from '../server/loadProjectEnv.js';
import { mysqlConfigFromEnv } from '../server/mysqlDatabase.js';

const mysqlCandidates = [
  'C:\\xampp\\mysql\\bin\\mysql.exe',
  'C:\\Program Files\\xampp\\mysql\\bin\\mysql.exe',
  'C:\\Program Files\\MySQL\\MySQL Server 8.4\\bin\\mysql.exe',
  'C:\\Program Files\\MySQL\\MySQL Server 8.0\\bin\\mysql.exe',
  'mysql',
];

const statements = [
  "SELECT RELEASE_LOCK('zarewa_run_migrations')",
  "SELECT RELEASE_LOCK('zarewa_mig_zarewa_test')",
  'DROP DATABASE IF EXISTS zarewa_test',
];
for (let i = 1; i <= 8; i += 1) {
  statements.push(`SELECT RELEASE_LOCK('zarewa_mig_zarewa_test_w${i}')`);
  statements.push(`DROP DATABASE IF EXISTS zarewa_test_w${i}`);
}

async function resetViaMysql2() {
  loadProjectEnv();
  const cfg = mysqlConfigFromEnv();
  const c = await mysql.createConnection({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
  });
  try {
    for (const sql of statements) {
      const [rows] = await c.query(sql);
      if (Array.isArray(rows) && rows.length) console.log(JSON.stringify(rows));
    }
  } finally {
    await c.end();
  }
}

function runMysqlCli(sql) {
  for (const bin of mysqlCandidates) {
    const r = spawnSync(bin, ['-u', 'root', '-e', sql], { encoding: 'utf8' });
    if (r.status === 0) return { ok: true, out: (r.stdout || '') + (r.stderr || '') };
    if (r.error?.code === 'ENOENT') continue;
    return { ok: false, err: (r.stderr || r.stdout || r.error?.message || '').trim() };
  }
  return { ok: false, err: 'mysql client not found' };
}

console.log('Releasing migration lock and dropping test databases…');
try {
  await resetViaMysql2();
} catch (e) {
  console.warn(`[test:db:reset] mysql2 path failed (${e?.message || e}); trying mysql CLI…`);
  for (const sql of statements) {
    const r = runMysqlCli(sql);
    if (!r.ok) {
      console.error(r.err);
      process.exit(1);
    }
    if (r.out?.trim()) console.log(r.out.trim());
  }
}
console.log('Done. Run one vitest suite at a time (do not run parallel vitest processes).');
