#!/usr/bin/env node
/**
 * Ensures the built-in `admin` user exists with the default dev password from server/auth.js.
 *
 * Usage:
 *   node scripts/ensure-default-admin.mjs
 *   ZAREWA_DB=C:\\path\\to\\custom.sqlite node scripts/ensure-default-admin.mjs
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { ensureDefaultAdminUser } from '../server/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const dbPath = process.env.ZAREWA_DB || path.join(root, 'data', 'zarewa.sqlite');

const db = new Database(dbPath);
ensureDefaultAdminUser(db);
db.close();
console.log('Default admin ensured for', dbPath);
