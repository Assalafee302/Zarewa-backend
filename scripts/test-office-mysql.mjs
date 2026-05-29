#!/usr/bin/env node
/**
 * Run office desk MySQL integration tests when ZAREWA_MYSQL_* env is configured.
 */
import { spawnSync } from 'node:child_process';

const hasMysql =
  Boolean(process.env.ZAREWA_MYSQL_HOST || process.env.ZAREWA_MYSQL_USER) &&
  Boolean(process.env.ZAREWA_MYSQL_PASSWORD || process.env.ZAREWA_MYSQL_DATABASE);

if (!hasMysql) {
  console.error(
    'Skipping test:office-mysql — set ZAREWA_MYSQL_HOST, ZAREWA_MYSQL_USER, ZAREWA_MYSQL_PASSWORD, ZAREWA_MYSQL_DATABASE (see docs/WORKSPACE_OFFICE_OVERHAUL.md).'
  );
  process.exit(0);
}

console.log('Running office desk MySQL integration pack…');
const migrate = spawnSync('node', ['scripts/db-migrate.mjs'], { stdio: 'inherit', shell: process.platform === 'win32' });
if (migrate.status !== 0) process.exit(migrate.status ?? 1);

const tests = spawnSync(
  'npx',
  [
    'vitest',
    'run',
    'server/officeRecordOps.test.js',
    'server/filingNumberOps.test.js',
    'server/officialNoticesOps.test.js',
    'server/forumOps.test.js',
    'server/workspaceDeskOps.test.js',
  ],
  { stdio: 'inherit', shell: process.platform === 'win32' }
);
process.exit(tests.status ?? 1);
