import { createMysqlDatabase, databaseLabel, mysqlConfigFromEnv } from './mysqlDatabase.js';
import { runMigrations } from './migrate.js';

/**
 * Open MySQL for one-off CLI scripts (schema bootstrap + optional migrations).
 * @param {{ database?: string; migrate?: boolean }} [opts]
 */
export function openConfiguredMysql(opts = {}) {
  const cfg = mysqlConfigFromEnv();
  if (opts.database) cfg.database = String(opts.database);
  const db = createMysqlDatabase(cfg, { reset: false });
  db.pragma('foreign_keys = ON');
  if (opts.migrate !== false) runMigrations(db);
  return {
    db,
    cfg,
    label: () => databaseLabel(cfg),
  };
}
