#!/usr/bin/env node
/**
 * Step 1 — Import on a staging copy (keeps a timestamped backup of the live DB).
 *
 *   node scripts/staging-import-access.mjs
 *   node scripts/staging-import-access.mjs -- --strict-customer-merge
 *
 * Produces:
 *   data/zarewa.sqlite.<timestamp>.bak   (backup of current file)
 *   data/zarewa-import-staging.sqlite      (copy + import target)
 *
 * Then validate:  npm run import:validate -- --db data/zarewa-import-staging.sqlite
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultDbPath } from '../server/db.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainDb = path.resolve(defaultDbPath());

if (!fs.existsSync(mainDb)) {
  console.error('No database file at:', mainDb);
  process.exit(1);
}

const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const backup = mainDb.replace(/\.sqlite$/i, `.sqlite.${stamp}.bak`);
const staging = path.join(path.dirname(mainDb), 'zarewa-import-staging.sqlite');

fs.copyFileSync(mainDb, backup);
console.log('Backup written:', backup);
fs.copyFileSync(mainDb, staging);
console.log('Staging copy:', staging);

const importScript = path.join(root, 'server', 'importAccessSalesPack.mjs');
const extra = process.argv.slice(2).filter((a) => a !== '--');
const args = [importScript, '--db', staging, '--dir', path.join(root, 'docs', 'import'), ...extra];

const r = spawnSync(process.execPath, args, {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, ZAREWA_DB: staging },
});

if (r.status !== 0) {
  console.error('Import failed with exit', r.status);
  process.exit(r.status ?? 1);
}

console.log('\nNext: npm run import:validate -- --db data/zarewa-import-staging.sqlite');
