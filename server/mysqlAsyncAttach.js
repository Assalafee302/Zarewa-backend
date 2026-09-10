import mysql from 'mysql2/promise';
import { adaptSqlForMysql, adaptExecSqlForMysql } from './mysqlSqlAdapt.js';

function countQueryPlaceholders(sql) {
  const s = String(sql || '');
  let count = 0;
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if ((inSingle || inDouble) && c === '\\') {
      i += 1;
      continue;
    }
    if (c === "'" && !inDouble && !inBacktick) inSingle = !inSingle;
    else if (c === '"' && !inSingle && !inBacktick) inDouble = !inDouble;
    else if (c === '`' && !inSingle && !inDouble) inBacktick = !inBacktick;
    else if (c === '?' && !inSingle && !inDouble && !inBacktick) count += 1;
  }
  return count;
}

/**
 * Main-thread async MySQL API (no Atomics.wait). HTTP hot paths should migrate here
 * so concurrent requests can interleave while the sync synckit facade remains for migrate/seed.
 * @param {object} db sync database facade from createMysqlDatabase
 * @param {import('./mysqlDatabase.js').MysqlEnvConfig} cfg
 */
export function attachAsyncMysql(db, cfg) {
  if (db?.async) return db;
  const pool = mysql.createPool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    waitForConnections: true,
    connectionLimit: Math.max(2, Number(process.env.ZAREWA_MYSQL_ASYNC_POOL_SIZE) || 8),
    multipleStatements: true,
    charset: 'utf8mb4',
  });

  async function execute(sql, args = []) {
    const adapted = adaptSqlForMysql(String(sql || ''), args);
    const placeholders = countQueryPlaceholders(adapted.sql);
    const actual = Array.isArray(adapted.args) ? adapted.args.length : 0;
    if (placeholders > 0 && actual !== placeholders) {
      throw new Error(
        `SQL bind mismatch: ${placeholders} placeholder(s) but ${actual} value(s) (async)`
      );
    }
    const [rows] = await pool.execute(adapted.sql, adapted.args);
    return rows;
  }

  db.async = {
    prepare(sql) {
      const s = String(sql || '');
      return {
        async all(...args) {
          const rows = await execute(s, args);
          return Array.isArray(rows) ? rows : [];
        },
        async get(...args) {
          const rows = await execute(s, args);
          return Array.isArray(rows) && rows.length ? rows[0] : undefined;
        },
        async run(...args) {
          const adapted = adaptSqlForMysql(s, args);
          const [result] = await pool.execute(adapted.sql, adapted.args);
          return {
            changes: Number(result?.affectedRows) || 0,
            lastInsertRowid: result?.insertId ?? 0,
          };
        },
      };
    },
    async exec(sql) {
      const adapted = adaptExecSqlForMysql(String(sql || ''));
      await pool.query(adapted);
    },
    async close() {
      await pool.end();
    },
  };

  const prevClose = typeof db.close === 'function' ? db.close.bind(db) : null;
  db.close = () => {
    void pool.end().catch(() => {});
    if (prevClose) prevClose();
  };

  return db;
}
