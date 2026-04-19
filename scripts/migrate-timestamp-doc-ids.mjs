/**
 * Run timestamp-style LE-/CL- id rewrite on the default SQLite file (backup DB first in production).
 * Also runs automatically via server/migrate.js on every API start.
 */
import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { migrateTimestampStyleDocumentIds } from '../server/migrateTimestampDocIds.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = path.join(__dirname, '..', 'data', 'zarewa.sqlite');
const db = new Database(dbPath);
migrateTimestampStyleDocumentIds(db);
db.close();
console.log('Timestamp document id migration applied (no-op if nothing matched).');
