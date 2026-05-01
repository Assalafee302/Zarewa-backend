#!/usr/bin/env node
/**
 * Wipes the configured MySQL database (same as npm run db:wipe). After this, run a fresh seed
 * without demo data:
 *
 *   npm run db:fresh-empty
 *
 * Or start the API only with empty seed (you still need schema — run db:migrate or db:fresh-empty):
 *   PowerShell:  $env:ZAREWA_EMPTY_SEED='1'; npm run server
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadProjectEnv } from '../server/loadProjectEnv.js';

loadProjectEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const r = spawnSync(process.execPath, ['scripts/wipe-local-mysql.mjs'], {
  cwd: root,
  stdio: 'inherit',
  env: process.env,
});
if (r.status !== 0) process.exit(r.status ?? 1);
console.log('');
console.log('Next: npm run db:fresh-empty   (recommended)');
console.log('  or: npm run db:migrate && ZAREWA_EMPTY_SEED=1 npm run server');
