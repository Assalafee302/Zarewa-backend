#!/usr/bin/env node
/**
 * Apply schema + incremental migrations to the configured MySQL database (no seed).
 *
 *   node scripts/db-migrate.mjs
 */
import { createMysqlDatabase, mysqlConfigFromEnv, databaseLabel } from '../server/mysqlDatabase.js';
import { runMigrations } from '../server/migrate.js';

const cfg = mysqlConfigFromEnv();
const db = createMysqlDatabase(cfg, { reset: false });
db.pragma('foreign_keys = ON');
runMigrations(db);
db.close();
console.log(`Migrations applied: ${databaseLabel(cfg)}`);
