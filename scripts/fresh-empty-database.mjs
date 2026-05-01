#!/usr/bin/env node
/**
 * Drops all MySQL tables, reapplies migrations, and seeds a minimal non-demo database:
 * default users, master templates, one zero-balance treasury account, HR stubs — no demo
 * customers, quotations, receipts, procurement, or legacy demo pack.
 * Document / human-id counters reset because tables are recreated from scratch.
 *
 * Stop the API before running (avoid locks / partial state).
 *
 * Requires explicit confirmation:
 *   ZAREWA_CONFIRM_FRESH_EMPTY=1 npm run db:fresh-empty
 *
 * PowerShell:
 *   $env:ZAREWA_CONFIRM_FRESH_EMPTY='1'; npm run db:fresh-empty
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const { loadProjectEnv } = await import('../server/loadProjectEnv.js');
loadProjectEnv();

if (String(process.env.ZAREWA_CONFIRM_FRESH_EMPTY || '').trim() !== '1') {
  console.error(
    '[zarewa] Refusing fresh-empty: set ZAREWA_CONFIRM_FRESH_EMPTY=1 (full wipe + minimal seed). Stop the API first.'
  );
  process.exit(1);
}

process.env.ZAREWA_EMPTY_SEED = '1';
process.env.ZAREWA_CONFIRM_DB_WIPE = '1';

const wipe = spawnSync(process.execPath, ['scripts/wipe-local-mysql.mjs'], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});
if (wipe.status !== 0) process.exit(wipe.status ?? 1);

const { createDatabase } = await import('../server/db.js');
const db = createDatabase();
db.close();

console.log('');
console.log('Fresh database ready: schema + auth + master data + minimal treasury (no demo sales/procurement).');
console.log('Keep ZAREWA_EMPTY_SEED=1 in your server environment if you never want transactional demo seeds on empty tables.');
