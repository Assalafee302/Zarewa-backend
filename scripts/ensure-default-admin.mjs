#!/usr/bin/env node
/**
 * Ensures the built-in `admin` user exists with the default dev password from server/auth.js.
 *
 * Usage:
 *   node scripts/ensure-default-admin.mjs
 */
import { openConfiguredMysql } from '../server/cliMysql.js';
import { ensureDefaultAdminUser } from '../server/auth.js';

const { db, label } = openConfiguredMysql({ migrate: true });
ensureDefaultAdminUser(db);
db.close();
console.log('Default admin ensured for', label());
