#!/usr/bin/env node
/**
 * Apply schema + incremental migrations to the SQLite file without running seed.
 * Use when the API was started before new migrations existed, or to fix "no such column" errors.
 *
 *   node scripts/db-migrate.mjs
 *   set ZAREWA_DB=C:\path\to\custom.sqlite && node scripts/db-migrate.mjs
 *
 * Stop the API first if you get SQLITE_BUSY; otherwise WAL usually allows this.
 */
import Database from 'better-sqlite3';
import { SCHEMA_SQL } from '../server/schemaSql.js';
import { runMigrations } from '../server/migrate.js';
import { defaultDbPath } from '../server/db.js';

const dbPath = process.env.ZAREWA_DB || defaultDbPath();
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(SCHEMA_SQL);
runMigrations(db);
db.close();
console.log(`Migrations applied: ${dbPath}`);
