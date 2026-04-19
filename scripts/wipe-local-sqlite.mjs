#!/usr/bin/env node
/**
 * Deletes the default local SQLite files so the next `npm run server` bootstraps a fresh DB
 * (schema + migrations + seed). Stops if the API still holds the DB open.
 *
 * Usage:
 *   node scripts/wipe-local-sqlite.mjs
 *   ZAREWA_DB=C:\\path\\to\\custom.sqlite node scripts/wipe-local-sqlite.mjs
 *
 * Then: stop the API if it was running, run `npm run server`, run `npm run stress:lifecycle`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const dbPath = process.env.ZAREWA_DB || path.join(root, 'data', 'zarewa.sqlite');

const siblings = [dbPath, `${dbPath}-wal`, `${dbPath}-shm`];
let removed = 0;
for (const p of siblings) {
  try {
    if (fs.existsSync(p)) {
      fs.rmSync(p, { force: true });
      removed += 1;
      console.log('removed', p);
    }
  } catch (e) {
    console.error('failed', p, String(e?.message || e));
    console.error('Tip: stop the Zarewa API process, then run this script again.');
    process.exitCode = 1;
    break;
  }
}
if (!removed) console.log('nothing to remove at', dbPath);
