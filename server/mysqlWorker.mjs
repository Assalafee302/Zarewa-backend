import mysql from 'mysql2/promise';
import { runAsWorker } from 'synckit';
import { sqliteDdlToMysql } from './schemaMysqlTransform.js';
import { adaptSqlForMysql, adaptExecSqlForMysql } from './mysqlSqlAdapt.js';

/** @type {import('mysql2/promise').Pool | null} */
let pool = null;
/** @type {import('mysql2/promise').PoolConnection | null} */
let txConn = null;
let txDepth = 0;

/** Split `sql` on `;` outside quotes / backticks (for multipleStatements batches). */
function splitSqlStatements(sql) {
  const s = String(sql || '');
  const out = [];
  let cur = '';
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" && !inDouble && !inBacktick) inSingle = !inSingle;
    else if (c === '"' && !inSingle && !inBacktick) inDouble = !inDouble;
    else if (c === '`' && !inSingle && !inDouble) inBacktick = !inBacktick;
    else if (c === ';' && !inSingle && !inDouble && !inBacktick) {
      const t = cur.trim();
      if (t) out.push(t);
      cur = '';
      continue;
    }
    cur += c;
  }
  const t = cur.trim();
  if (t) out.push(t);
  return out;
}

function isDuplicateIndexNameError(e) {
  const errno = /** @type {{ errno?: number }} */ (e).errno;
  const code = /** @type {{ code?: string }} */ (e).code;
  return errno === 1061 || code === 'ER_DUP_KEYNAME';
}

async function ensurePool(cfg) {
  if (!pool) {
    pool = mysql.createPool({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      waitForConnections: true,
      connectionLimit: cfg.connectionLimit ?? 12,
      multipleStatements: true,
      charset: 'utf8mb4',
    });
  }
}

function execTarget() {
  if (txDepth > 0 && txConn) return txConn;
  if (!pool) throw new Error('MySQL pool not initialized');
  return pool;
}

/**
 * @param {string} ddl
 */
async function execBootstrapDdl(ddl) {
  const transformed = sqliteDdlToMysql(ddl);
  const parts = transformed
    .split(/;\s*\n/)
    .map((x) => x.trim())
    .filter(Boolean);
  const conn = await pool.getConnection();
  try {
    await conn.query('SET NAMES utf8mb4');
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const part of parts) {
      const stmt = part.endsWith(';') ? part : `${part};`;
      try {
        await conn.query(stmt);
      } catch (e) {
        const errno = /** @type {{ errno?: number }} */ (e).errno;
        const code = /** @type {{ code?: string }} */ (e).code;
        if (errno === 1061 || code === 'ER_DUP_KEYNAME') continue;
        throw e;
      }
    }
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  } finally {
    conn.release();
  }
}

async function wipeAllTables() {
  const conn = await pool.getConnection();
  try {
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');
    const [rows] = await conn.query(
      'SELECT TABLE_NAME AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = ?',
      ['BASE TABLE']
    );
    const names = /** @type {{ n: string }[]} */ (rows).map((r) => r.n);
    for (const name of names) {
      await conn.query(`DROP TABLE IF EXISTS \`${String(name).replace(/`/g, '')}\``);
    }
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  } finally {
    conn.release();
  }
}

async function execRaw(sql) {
  const conn = execTarget();
  const adapted = adaptExecSqlForMysql(String(sql || ''));
  const parts = splitSqlStatements(adapted);
  if (!parts.length) return;
  for (const part of parts) {
    const stmt = part.endsWith(';') ? part : `${part};`;
    try {
      await conn.query(stmt);
    } catch (e) {
      /* Migrations repeat CREATE INDEX after bootstrap; SQLite had IF NOT EXISTS. */
      if (isDuplicateIndexNameError(e) && /^\s*CREATE\s+(UNIQUE\s+)?INDEX\b/i.test(part)) {
        continue;
      }
      throw e;
    }
  }
}

async function runStatement(sql, args) {
  const { sql: sql2, args: a2 } = adaptSqlForMysql(sql, args);
  const conn = execTarget();
  const [res] = await conn.query(sql2, a2);
  return res;
}

runAsWorker(async (payload) => {
  const op = payload?.op;
  if (op === 'init') {
    const { config } = payload;
    if (pool) {
      await pool.end();
      pool = null;
    }
    txConn = null;
    txDepth = 0;
    await ensurePool(config);
    return { ok: true };
  }

  if (op === 'close') {
    if (pool) {
      await pool.end();
      pool = null;
    }
    txConn = null;
    txDepth = 0;
    return { ok: true };
  }

  if (op === 'wipeAllTables') {
    await wipeAllTables();
    return { ok: true };
  }

  if (op === 'bootstrapSchema') {
    await execBootstrapDdl(payload.ddl);
    return { ok: true };
  }

  if (op === 'exec') {
    await execRaw(payload.sql);
    return { ok: true };
  }

  if (op === 'run') {
    const res = await runStatement(payload.sql, payload.args || []);
    const hdr = /** @type {import('mysql2').ResultSetHeader} */ (res);
    return {
      changes: hdr.affectedRows ?? 0,
      lastInsertRowid: hdr.insertId != null ? Number(hdr.insertId) : 0,
    };
  }

  if (op === 'get') {
    const { sql, args } = adaptSqlForMysql(payload.sql, payload.args || []);
    const conn = execTarget();
    const [rows] = await conn.query(sql, args);
    const list = /** @type {Record<string, unknown>[]} */ (rows);
    return list[0] ?? undefined;
  }

  if (op === 'all') {
    const { sql, args } = adaptSqlForMysql(payload.sql, payload.args || []);
    const conn = execTarget();
    const [rows] = await conn.query(sql, args);
    return /** @type {Record<string, unknown>[]} */ (rows);
  }

  if (op === 'txBegin') {
    if (!pool) throw new Error('MySQL pool not initialized');
    if (txDepth === 0) {
      txConn = await pool.getConnection();
      await txConn.beginTransaction();
    } else {
      await txConn.query(`SAVEPOINT sp_${txDepth}`);
    }
    txDepth += 1;
    return { ok: true };
  }

  if (op === 'txCommit') {
    if (txDepth <= 0) throw new Error('txCommit without active transaction');
    txDepth -= 1;
    if (txDepth === 0) {
      await txConn.commit();
      txConn.release();
      txConn = null;
    } else {
      await txConn.query(`RELEASE SAVEPOINT sp_${txDepth}`);
    }
    return { ok: true };
  }

  if (op === 'txRollback') {
    if (txDepth <= 0) throw new Error('txRollback without active transaction');
    txDepth -= 1;
    if (txDepth === 0) {
      await txConn.rollback();
      txConn.release();
      txConn = null;
    } else {
      await txConn.query(`ROLLBACK TO SAVEPOINT sp_${txDepth}`);
    }
    return { ok: true };
  }

  throw new Error(`Unknown mysql worker op: ${op}`);
});
