#!/usr/bin/env node
/**
 * Reset Vitest MySQL worker databases and release migration lock.
 * Run before integration suites when a prior run was killed mid-migrate.
 */
import { spawnSync } from 'node:child_process';

const mysqlCandidates = [
  'C:\\xampp\\mysql\\bin\\mysql.exe',
  'C:\\Program Files\\xampp\\mysql\\bin\\mysql.exe',
  'mysql',
];

function runMysql(sql) {
  for (const bin of mysqlCandidates) {
    const r = spawnSync(bin, ['-u', 'root', '-e', sql], { encoding: 'utf8' });
    if (r.status === 0) return { ok: true, bin, out: (r.stdout || '') + (r.stderr || '') };
    if (r.error?.code === 'ENOENT') continue;
    return { ok: false, bin, err: (r.stderr || r.stdout || r.error?.message || '').trim() };
  }
  return { ok: false, err: 'mysql client not found (start XAMPP MySQL)' };
}

console.log('Releasing migration lock and dropping test databases…');
const statements = [
  "SELECT RELEASE_LOCK('zarewa_run_migrations')",
  'DROP DATABASE IF EXISTS zarewa_test',
];
for (let i = 1; i <= 8; i += 1) {
  statements.push(`DROP DATABASE IF EXISTS zarewa_test_w${i}`);
}
for (const sql of statements) {
  const r = runMysql(sql);
  if (!r.ok) {
    console.error(r.err);
    process.exit(1);
  }
  if (r.out?.trim()) console.log(r.out.trim());
}
console.log('Done. Run one vitest suite at a time (do not run parallel vitest processes).');
