#!/usr/bin/env node
/**
 * Post-audit verification gate: MySQL migrate (test DB), security unit tests, API smoke, frontend critical lib.
 *
 *   node scripts/audit-verify.mjs
 *   npm run verify:audit
 */
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveFrontendRoot } from './frontendPaths.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const frontendRoot = resolveFrontendRoot();
const isWin = process.platform === 'win32';
const npmSpawn = () => ({ cmd: isWin ? 'npm.cmd' : 'npm', shell: isWin });

function run(title, args, opts = {}) {
  console.log(`\n${'='.repeat(72)}\n  ${title}\n${'='.repeat(72)}\n`);
  const { cmd, shell } = npmSpawn();
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd || root,
    stdio: 'inherit',
    shell,
    env: { ...process.env, FORCE_COLOR: '1', ...opts.env },
  });
  if (r.error) {
    console.error(`\n[verify:audit] FAILED: ${title}\n`, r.error);
    process.exit(1);
  }
  if (r.signal) {
    console.error(`\n[verify:audit] FAILED: ${title} (signal ${r.signal})\n`);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error(`\n[verify:audit] FAILED: ${title} (exit ${r.status ?? 1})\n`);
    process.exit(r.status ?? 1);
  }
}

function warn(title, args, opts = {}) {
  console.log(`\n${'─'.repeat(72)}\n  ${title} (non-fatal)\n${'─'.repeat(72)}\n`);
  const { cmd, shell } = npmSpawn();
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd || root,
    stdio: 'inherit',
    shell,
    env: { ...process.env, ...opts.env },
  });
  if (r.status !== 0) {
    console.warn(`[verify:audit] Warning: ${title} exited ${r.status ?? 1} — check ZAREWA_MYSQL_* in .env`);
  }
}

warn('MySQL smoke (main database)', ['run', 'mysql:smoke'], { cwd: root });

const testDb = String(process.env.ZAREWA_MYSQL_TEST_DATABASE || 'zarewa_test').trim() || 'zarewa_test';
run(`Migrations (${testDb})`, ['run', 'db:migrate'], {
  cwd: root,
  env: { ZAREWA_MYSQL_DATABASE: testDb },
});

run('Security audit unit tests (backend)', ['run', 'test:security-audit'], { cwd: root });

run('API security smoke (in-process)', ['run', 'test:audit-api-smoke'], { cwd: root });

run('Critical frontend lib tests', ['run', 'test:critical-lib'], { cwd: frontendRoot });

console.log(`
${'*'.repeat(72)}
  VERIFY AUDIT — all gates passed
${'*'.repeat(72)}
`);
