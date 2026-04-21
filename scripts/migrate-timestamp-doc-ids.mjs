/**
 * Run timestamp-style LE-/CL- id rewrite on the configured MySQL database (backup first in production).
 * Also runs automatically via server/migrate.js on every API start.
 */
import { createMysqlDatabase, databaseLabel, mysqlConfigFromEnv } from '../server/mysqlDatabase.js';
import { migrateTimestampStyleDocumentIds } from '../server/migrateTimestampDocIds.js';

const cfg = mysqlConfigFromEnv();
const db = createMysqlDatabase(cfg, { reset: false });
db.pragma('foreign_keys = ON');
migrateTimestampStyleDocumentIds(db);
db.close();
console.log(`Timestamp document id migration applied on ${databaseLabel(cfg)} (no-op if nothing matched).`);
