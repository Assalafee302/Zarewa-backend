#!/usr/bin/env node
/**
 * Deletes the default SQLite file(s), same as db:wipe. After this, start the API with
 * ZAREWA_EMPTY_SEED=1 so the DB is recreated with schema + auth + master templates only
 * (no demo customers, quotations, receipts, procurement, etc.).
 *
 * PowerShell:  $env:ZAREWA_EMPTY_SEED='1'; npm run server
 * Unix:        ZAREWA_EMPTY_SEED=1 npm run server
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const r = spawnSync(process.execPath, ['scripts/wipe-local-sqlite.mjs'], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});
if (r.status !== 0) process.exit(r.status ?? 1);
console.log('');
console.log('Next: set ZAREWA_EMPTY_SEED=1, then npm run server (stop any running API first).');
console.log('  PowerShell:  $env:ZAREWA_EMPTY_SEED=\'1\'; npm run server');
console.log('  cmd.exe:     set ZAREWA_EMPTY_SEED=1 && npm run server');
