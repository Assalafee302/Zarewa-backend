import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createSyncFn } from 'synckit';
import { SCHEMA_SQL } from './schemaSql.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workerPath = path.join(__dirname, 'mysqlWorker.mjs');

/**
 * @typedef {object} MysqlEnvConfig
 * @property {string} host
 * @property {number} port
 * @property {string} user
 * @property {string} password
 * @property {string} database
 */

/** @returns {MysqlEnvConfig} */
export function mysqlConfigFromEnv() {
  return {
    host: String(process.env.ZAREWA_MYSQL_HOST || '127.0.0.1').trim() || '127.0.0.1',
    port: Number(process.env.ZAREWA_MYSQL_PORT || 3306) || 3306,
    user: String(process.env.ZAREWA_MYSQL_USER || 'root').trim() || 'root',
    password: String(process.env.ZAREWA_MYSQL_PASSWORD ?? ''),
    database: String(process.env.ZAREWA_MYSQL_DATABASE || 'zarewa_db').trim() || 'zarewa_db',
  };
}

export function databaseLabel(cfg = mysqlConfigFromEnv()) {
  return `${cfg.host}:${cfg.port}/${cfg.database}`;
}

/**
 * @param {MysqlEnvConfig} cfg
 * @param {{ reset?: boolean }} opts reset = wipe all tables before bootstrap (for tests)
 */
export function createMysqlDatabase(cfg, opts = {}) {
  const envTimeout = Number(process.env.ZAREWA_MYSQL_SYNC_TIMEOUT_MS || 0);
  const syncTimeout =
    envTimeout > 0
      ? envTimeout
      : process.env.NODE_ENV === 'test' || process.env.VITEST === 'true'
        ? 300_000
        : 600_000;
  const syncFn = createSyncFn(workerPath, { timeout: syncTimeout });
  syncFn({ op: 'init', config: cfg });
  if (opts.reset) {
    syncFn({ op: 'wipeAllTables' });
  }
  syncFn({ op: 'bootstrapSchema', ddl: SCHEMA_SQL });

  return {
    pragma(key, val) {
      const k = String(key || '').trim();
      if (k === 'journal_mode') return;
      if (k === 'foreign_keys' && String(val).trim() === 'ON') {
        syncFn({ op: 'exec', sql: 'SET SESSION foreign_key_checks = 1' });
      }
    },
    exec(sql) {
      syncFn({ op: 'exec', sql: String(sql || '') });
    },
    prepare(sql) {
      const s = String(sql || '');
      return {
        run(...args) {
          return syncFn({ op: 'run', sql: s, args });
        },
        get(...args) {
          return syncFn({ op: 'get', sql: s, args });
        },
        all(...args) {
          return syncFn({ op: 'all', sql: s, args });
        },
      };
    },
    runMany(statements) {
      const list = Array.isArray(statements) ? statements : [];
      if (!list.length) return { changes: 0 };
      return syncFn({ op: 'runMany', statements: list });
    },
    transaction(fn) {
      return (...args) => {
        syncFn({ op: 'txBegin' });
        try {
          const ret = fn(...args);
          syncFn({ op: 'txCommit' });
          return ret;
        } catch (e) {
          try {
            syncFn({ op: 'txRollback' });
          } catch {
            /* ignore */
          }
          throw e;
        }
      };
    },
    close() {
      syncFn({ op: 'close' });
    },
  };
}
