#!/usr/bin/env node
/**
 * Drops all MySQL tables, reapplies migrations, and seeds a minimal non-demo database:
 * default users, master templates, one zero-balance treasury account, HR stubs — no demo
 * customers, quotations, receipts, procurement, or legacy demo pack.
 *
 * Stop the API before running (avoid locks / partial state).
 *
 *   npm run db:fresh-empty
 *
 * PowerShell:  npm run db:fresh-empty
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const { loadProjectEnv } = await import('../server/loadProjectEnv.js');
loadProjectEnv();

process.env.ZAREWA_EMPTY_SEED = '1';

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
