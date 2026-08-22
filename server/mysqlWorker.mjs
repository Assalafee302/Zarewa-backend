import mysql from 'mysql2/promise';
import { runAsWorker } from 'synckit';
import { sqliteDdlToMysql } from './schemaMysqlTransform.js';
import { adaptSqlForMysql, adaptExecSqlForMysql } from './mysqlSqlAdapt.js';

/** @type {import('mysql2/promise').Pool | null} */
let pool = null;
/** Database name for GET_LOCK serialization of wipe + SCHEMA_SQL. */
let activeDbName = '';
/** @type {import('mysql2/promise').PoolConnection | null} */
let txConn = null;
let txDepth = 0;
/** Monotonic names for nested SAVEPOINT / RELEASE / ROLLBACK (avoids sp_depth drift bugs). */
let savepointSeq = 0;
/** @type {string[]} */
let savepointStack = [];

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

/**
 * Count `?` placeholders in `sql`, ignoring `?` that appear inside
 * quoted string / identifier literals. mysql2 silently leaves unmatched
 * `?` in the SQL when `args` is short, which becomes the MariaDB error
 * `near '?' at line N` — this helper lets us catch the mismatch first.
 */
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

/** Compact SQL for inclusion in error messages (single-line, capped length). */
function sqlForError(sql) {
  return String(sql || '').replace(/\s+/g, ' ').trim().slice(0, 240);
}

function annotateSqlError(err, sql, args) {
  const baseMessage = err?.sqlMessage || err?.message || String(err);
  const argsLen = Array.isArray(args) ? args.length : 0;
  const placeholders = countQueryPlaceholders(sql);
  if (!err || typeof err !== 'object') {
    return new Error(
      `${baseMessage} | sql="${sqlForError(sql)}" | binds=${argsLen}/${placeholders}`
    );
  }
  try {
    err.message = `${baseMessage} | sql="${sqlForError(sql)}" | binds=${argsLen}/${placeholders}`;
  } catch {
    /* read-only message — fall back to wrapping. */
    return new Error(
      `${baseMessage} | sql="${sqlForError(sql)}" | binds=${argsLen}/${placeholders}`
    );
  }
  return err;
}

function assertBindCount(sql, args) {
  const placeholders = countQueryPlaceholders(sql);
  const actual = Array.isArray(args) ? args.length : 0;
  if (placeholders > 0 && actual !== placeholders) {
    throw new Error(
      `SQL bind mismatch: ${placeholders} placeholder(s) but ${actual} value(s) ` +
        `provided. MariaDB would reject this with "near '?'" — sql="${sqlForError(sql)}"`
    );
  }
}

function isDuplicateIndexNameError(e) {
  const errno = /** @type {{ errno?: number }} */ (e).errno;
  const code = /** @type {{ code?: string }} */ (e).code;
  return errno === 1061 || code === 'ER_DUP_KEYNAME';
}

/** Bootstrap + re-run of CREATE/ALTER may re-apply ADD COLUMN after full SCHEMA_SQL. */
function isDuplicateColumnError(e) {
  const errno = /** @type {{ errno?: number }} */ (e).errno;
  const code = /** @type {{ code?: string }} */ (e).code;
  const msg = String(e?.sqlMessage || e?.message || '');
  return errno === 1060 || code === 'ER_DUP_FIELDNAME' || /duplicate column name/i.test(msg);
}

/** Legacy DBs may lack columns added later; migrations recreate these indexes after ALTER. */
function isMissingIndexColumnError(e) {
  const errno = /** @type {{ errno?: number }} */ (e).errno;
  const code = /** @type {{ code?: string }} */ (e).code;
  return errno === 1072 || code === 'ER_KEY_COLUMN_DOES_NOT_EXITS';
}

function isDeadlockError(e) {
  const errno = /** @type {{ errno?: number }} */ (e).errno;
  const code = /** @type {{ code?: string }} */ (e).code;
  return errno === 1213 || code === 'ER_LOCK_DEADLOCK';
}

function deadlockBackoffMs(attempt) {
  return Math.min(80 * attempt, 800);
}

function schemaLockName() {
  const db = String(activeDbName || '').replace(/`/g, '').trim();
  const raw = db ? `zarewa_mig_${db}` : 'zarewa_run_migrations';
  return raw.length <= 64 ? raw : raw.slice(0, 64);
}

/**
 * Hold GET_LOCK on one connection for wipe + bootstrap so concurrent Vitest
 * processes cannot interleave DROP TABLE with CREATE TABLE.
 * @template T
 * @param {(conn: import('mysql2/promise').PoolConnection) => Promise<T>} fn
 */
async function withSchemaLock(fn) {
  if (!pool) throw new Error('MySQL pool not initialized');
  const conn = await pool.getConnection();
  const lockName = schemaLockName();
  let acquired = false;
  try {
    const [rows] = await conn.query('SELECT GET_LOCK(?, ?) AS got', [lockName, 120]);
    acquired = Number(/** @type {{ got?: number }[]} */ (rows)[0]?.got) === 1;
    if (!acquired) {
      throw new Error(
        `Could not acquire schema lock "${lockName}" within 120s. Stop other Vitest/API processes using this database.`
      );
    }
    return await fn(conn);
  } finally {
    if (acquired) {
      try {
        await conn.query('SELECT RELEASE_LOCK(?)', [lockName]);
      } catch {
        /* connection may already be gone */
      }
    }
    conn.release();
  }
}

/**
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{ attempts?: number }} [opts]
 */
async function withDeadlockRetry(fn, opts = {}) {
  const attempts = Math.max(Number(opts.attempts) || 4, 1);
  let lastErr;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      if (!isDeadlockError(e) || i >= attempts) throw e;
      await new Promise((r) => setTimeout(r, deadlockBackoffMs(i)));
    }
  }
  throw lastErr;
}

function isSkippableBootstrapIndexError(e, stmt) {
  if (!/^\s*CREATE\s+(UNIQUE\s+)?INDEX\b/i.test(String(stmt || ''))) return false;
  return isDuplicateIndexNameError(e) || isMissingIndexColumnError(e);
}

async function ensureDatabaseExists(cfg) {
  const dbName = String(cfg?.database || '').replace(/`/g, '');
  if (!dbName) throw new Error('MySQL database name is required');
  const conn = await mysql.createConnection({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    multipleStatements: true,
  });
  try {
    await conn.query(
      `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
  } finally {
    await conn.end();
  }
}

async function ensurePool(cfg) {
  activeDbName = String(cfg?.database || '').replace(/`/g, '');
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
 * @param {import('mysql2/promise').PoolConnection} conn
 * @param {string} ddl
 */
async function execBootstrapDdlOn(conn, ddl) {
  const transformed = sqliteDdlToMysql(ddl);
  const parts = transformed
    .split(/;\s*\n/)
    .map((x) => x.trim())
    .filter(Boolean);
  await conn.query('SET NAMES utf8mb4');
  /* Allow bootstrap DDL shapes mapped from SQLite (TEXT defaults stripped separately). */
  await conn.query(`SET SESSION sql_mode = 'NO_ENGINE_SUBSTITUTION'`);
  await conn.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const part of parts) {
    const stmt = part.endsWith(';') ? part : `${part};`;
    let lastErr;
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      try {
        await conn.query(stmt);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        if (isSkippableBootstrapIndexError(e, part)) {
          lastErr = null;
          break;
        }
        if (!isDeadlockError(e) || attempt === 8) {
          throw e;
        }
        await new Promise((r) => setTimeout(r, deadlockBackoffMs(attempt)));
      }
    }
    if (lastErr) throw lastErr;
  }
  await conn.query('SET FOREIGN_KEY_CHECKS = 1');
}

/**
 * @param {import('mysql2/promise').PoolConnection} conn
 */
async function wipeAllTablesOn(conn) {
  await conn.query('SET FOREIGN_KEY_CHECKS = 0');
  const [rows] = await conn.query(
    'SELECT TABLE_NAME AS n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = ?',
    ['BASE TABLE']
  );
  const names = /** @type {{ n: string }[]} */ (rows).map((r) => r.n);
  for (const name of names) {
    const table = String(name).replace(/`/g, '');
    let lastErr;
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      try {
        await conn.query(`DROP TABLE IF EXISTS \`${table}\``);
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        if (!isDeadlockError(e) || attempt === 8) throw e;
        await new Promise((r) => setTimeout(r, deadlockBackoffMs(attempt)));
      }
    }
    if (lastErr) throw lastErr;
  }
  await conn.query('SET FOREIGN_KEY_CHECKS = 1');
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
      if (isSkippableBootstrapIndexError(e, part)) {
        continue;
      }
      /* Full SCHEMA_SQL + migrate ALTERs can re-add columns that already exist. */
      if (isDuplicateColumnError(e) && /^\s*ALTER\s+TABLE\b/i.test(part)) {
        continue;
      }
      throw e;
    }
  }
}

async function runStatement(sql, args) {
  return withDeadlockRetry(async () => {
    const { sql: sql2, args: a2 } = adaptSqlForMysql(String(sql || ''), args || []);
    assertBindCount(sql2, a2);
    const conn = execTarget();
    try {
      const [res] = await conn.query(sql2, a2);
      return res;
    } catch (e) {
      throw annotateSqlError(e, sql2, a2);
    }
  });
}

runAsWorker(async (payload) => {
  const op = payload?.op;
  if (op === 'ping') {
    const cfg = payload.config || {};
    const conn = await mysql.createConnection({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      connectTimeout: 8_000,
    });
    try {
      await conn.query('SELECT 1');
      return { ok: true };
    } finally {
      await conn.end();
    }
  }

  if (op === 'init') {
    const { config } = payload;
    if (pool) {
      await pool.end();
      pool = null;
    }
    activeDbName = '';
    txConn = null;
    txDepth = 0;
    savepointStack = [];
    await ensureDatabaseExists(config);
    await ensurePool(config);
    activeDbName = String(config?.database || '').replace(/`/g, '');
    return { ok: true };
  }

  if (op === 'close') {
    if (pool) {
      await pool.end();
      pool = null;
    }
    activeDbName = '';
    txConn = null;
    txDepth = 0;
    savepointStack = [];
    return { ok: true };
  }

  if (op === 'wipeAllTables') {
    await withSchemaLock((conn) => wipeAllTablesOn(conn));
    return { ok: true };
  }

  if (op === 'bootstrapSchema') {
    await withSchemaLock((conn) => execBootstrapDdlOn(conn, payload.ddl));
    return { ok: true };
  }

  if (op === 'resetAndBootstrap') {
    await withSchemaLock(async (conn) => {
      await wipeAllTablesOn(conn);
      await execBootstrapDdlOn(conn, payload.ddl);
    });
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

  if (op === 'runMany') {
    const statements = Array.isArray(payload.statements) ? payload.statements : [];
    let changes = 0;
    for (const item of statements) {
      const res = await runStatement(item?.sql, item?.args || []);
      const hdr = /** @type {import('mysql2').ResultSetHeader} */ (res);
      changes += hdr.affectedRows ?? 0;
    }
    return { changes };
  }

  if (op === 'get') {
    return withDeadlockRetry(async () => {
      const { sql, args } = adaptSqlForMysql(payload.sql, payload.args || []);
      assertBindCount(sql, args);
      const conn = execTarget();
      try {
        const [rows] = await conn.query(sql, args);
        const list = /** @type {Record<string, unknown>[]} */ (rows);
        return list[0] ?? undefined;
      } catch (e) {
        throw annotateSqlError(e, sql, args);
      }
    });
  }

  if (op === 'all') {
    return withDeadlockRetry(async () => {
      const { sql, args } = adaptSqlForMysql(payload.sql, payload.args || []);
      assertBindCount(sql, args);
      const conn = execTarget();
      try {
        const [rows] = await conn.query(sql, args);
        return /** @type {Record<string, unknown>[]} */ (rows);
      } catch (e) {
        throw annotateSqlError(e, sql, args);
      }
    });
  }

  if (op === 'txBegin') {
    if (!pool) throw new Error('MySQL pool not initialized');
    if (txDepth === 0) {
      txConn = await pool.getConnection();
      await txConn.beginTransaction();
      savepointStack = [];
    } else {
      if (!txConn) throw new Error('txBegin nested without active connection');
      savepointSeq += 1;
      const sp = `zsp_${savepointSeq}`;
      await txConn.query(`SAVEPOINT ${sp}`);
      savepointStack.push(sp);
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
      savepointStack = [];
    } else {
      const sp = savepointStack.pop();
      if (!sp) throw new Error('txCommit: savepoint stack underflow');
      await txConn.query(`RELEASE SAVEPOINT ${sp}`);
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
      savepointStack = [];
    } else {
      const sp = savepointStack.pop();
      if (!sp) {
        await txConn.rollback();
        txConn.release();
        txConn = null;
        txDepth = 0;
        savepointStack = [];
        return { ok: true };
      }
      await txConn.query(`ROLLBACK TO SAVEPOINT ${sp}`);
    }
    return { ok: true };
  }

  throw new Error(`Unknown mysql worker op: ${op}`);
});
