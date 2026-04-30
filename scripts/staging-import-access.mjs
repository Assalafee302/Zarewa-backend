#!/usr/bin/env node
/**
 * Step 1 — Import Access pack into a separate MySQL database (staging), leaving the main DB unchanged.
 *
 * Create the staging database first, e.g.:
 *   mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS zarewa_import_staging CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
 *
 * Backup the main DB before import (example):
 *   mysqldump -u root -p zarewa_db > backup-zarewa.sql
 *
 *   node scripts/staging-import-access.mjs
 *   node scripts/staging-import-access.mjs -- --strict-customer-merge
 *
 * Then validate:
 *   npm run import:validate -- --db zarewa_import_staging
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const stagingDb = String(process.env.ZAREWA_IMPORT_STAGING_DATABASE || 'zarewa_import_staging').trim();

const importScript = path.join(root, 'server', 'importAccessSalesPack.mjs');
const extra = process.argv.slice(2).filter((a) => a !== '--');
const args = [importScript, '--db', stagingDb, '--dir', path.join(root, 'docs', 'import'), ...extra];

const r = spawnSync(process.execPath, args, {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, ZAREWA_MYSQL_DATABASE: stagingDb },
});

if (r.status !== 0) {
  console.error('Import failed with exit', r.status);
  process.exit(r.status ?? 1);
}

console.log(`\nNext: npm run import:validate -- --db ${stagingDb}`);
