import {
  escapeMysqlReservedColumnNames,
  mysqlTypeForSqliteTextColumnName,
  stripMysqlIncompatibleIndexExprs,
} from './schemaMysqlTransform.js';

/**
 * Rewrites SQLite-oriented DDL fragments (e.g. migrate.js `db.exec`) for MySQL.
 * MySQL forbids DEFAULT (non-NULL literals) on TEXT/BLOB/MEDIUMTEXT, so those become VARCHAR.
 * @param {string} sql
 * @param {unknown[]} args arguments passed to .run/.get/.all (may be mutated for PRAGMA rewrite)
 * @returns {{ sql: string, args: unknown[] }}
 */
export function adaptExecSqlForMysql(sql) {
  let s = String(sql || '');
  /* Migrations use db.exec(); they skip sqliteDdlToMysql — SQLite AUTOINCREMENT is invalid on MariaDB. */
  s = s.replace(
    /\b(\w+)\s+INTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/gi,
    '$1 INT NOT NULL AUTO_INCREMENT PRIMARY KEY'
  );
  s = s.replace(/\bCREATE UNIQUE INDEX IF NOT EXISTS\b/gi, 'CREATE UNIQUE INDEX');
  s = s.replace(/\bCREATE INDEX IF NOT EXISTS\b/gi, 'CREATE INDEX');
  /* SQLite partial indexes — not supported in MySQL */
  s = s.replace(/\)\s*WHERE\b[\s\S]*?;/gi, ');');
  /* MariaDB rejects IFNULL(...) inside CREATE INDEX column lists (SQLite allows it). */
  if (/^\s*CREATE\s+(UNIQUE\s+)?INDEX\b/i.test(s.trim())) {
    s = stripMysqlIncompatibleIndexExprs(s);
  }
  /* Short widths keep composite indexes under InnoDB's ~3072-byte prefix limit. */
  const varcharForDefault = (col) =>
    /_id$|_ref$|_no$|_key$|_token$|^id$|^key$/i.test(col) ? 'VARCHAR(128)' : 'VARCHAR(255)';
  s = s.replace(/\b([a-z_][a-z0-9_]*)\s+TEXT(\s+NOT\s+NULL\s+DEFAULT\b)/gi, (_f, col, suf) => {
    return `${col} ${varcharForDefault(col)}${suf}`;
  });
  s = s.replace(/\b([a-z_][a-z0-9_]*)\s+TEXT(\s+DEFAULT\b)/gi, (_f, col, suf) => {
    return `${col} ${varcharForDefault(col)}${suf}`;
  });
  s = s.replace(/\b([a-z_][a-z0-9_]*)\s+TEXT\b/gi, (full, col) => {
    return `${col} ${mysqlTypeForSqliteTextColumnName(col)}`;
  });
  s = escapeMysqlReservedColumnNames(s);
  return s;
}

/**
 * better-sqlite3 accepts `.run({ user_id: 'x' })` with `@user_id` placeholders.
 * mysql2 needs `?` with positional values — expand when a single object bind is passed.
 * @param {string} sql
 * @param {unknown[]} args
 */
export function expandNamedBindParams(sql, args) {
  const s0 = String(sql || '');
  if (!/@([a-zA-Z_][a-zA-Z0-9_]*)/.test(s0)) {
    return { sql: s0, args: args != null ? [...args] : [] };
  }
  const outArgs = args != null ? [...args] : [];
  if (outArgs.length !== 1 || outArgs[0] == null || typeof outArgs[0] !== 'object' || Array.isArray(outArgs[0])) {
    return { sql: s0, args: outArgs };
  }
  const bind = /** @type {Record<string, unknown>} */ (outArgs[0]);
  const order = [];
  const sql2 = s0.replace(/@([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name) => {
    order.push(name);
    return '?';
  });
  const values = order.map((name) => bind[name]);
  return { sql: sql2, args: values };
}

/**
 * Adapted-SQL plan cache. Every query on the hot path (bootstrap alone issues
 * hundreds) used to re-run the full regex rewrite chain below; the rewrite is a
 * pure function of the SQL string, so memoise it and keep only the arg handling
 * per call. `fixedArgs === null` means "pass the caller's args through".
 * @type {Map<string, { sql: string, fixedArgs: unknown[] | null }>}
 */
const adaptPlanCache = new Map();
const ADAPT_PLAN_CACHE_MAX = 5000;

/** Drop memoised rewrites (schema-shape changes cannot alter them, but tests may want a clean slate). */
export function clearAdaptSqlCache() {
  adaptPlanCache.clear();
}

export function adaptSqlForMysql(sql, args) {
  const expanded = expandNamedBindParams(sql, args);
  const s0 = String(expanded.sql || '').trim();
  const outArgs = expanded.args != null ? [...expanded.args] : [];

  let plan = adaptPlanCache.get(s0);
  if (!plan) {
    plan = buildAdaptPlan(s0);
    /* Unbounded growth would only come from generated SQL; reset wholesale rather than track LRU. */
    if (adaptPlanCache.size >= ADAPT_PLAN_CACHE_MAX) adaptPlanCache.clear();
    adaptPlanCache.set(s0, plan);
  }
  return { sql: plan.sql, args: plan.fixedArgs ? [...plan.fixedArgs] : outArgs };
}

/**
 * Pure SQL→SQL rewrite, independent of bind values.
 * @param {string} s0 named-bind-expanded, trimmed SQL
 * @returns {{ sql: string, fixedArgs: unknown[] | null }}
 */
function buildAdaptPlan(s0) {
  let s = adaptExecSqlForMysql(s0);

  const pragma = /^PRAGMA\s+table_info\((['"`]?)([\w]+)\1\)\s*$/i.exec(s0);
  if (pragma) {
    const table = pragma[2];
    return {
      sql:
        'SELECT COLUMN_NAME AS name, DATA_TYPE AS type, ' +
        "CASE WHEN IS_NULLABLE = 'NO' THEN 1 ELSE 0 END AS notnull, " +
        'COLUMN_DEFAULT AS dflt_value, ' +
        "CASE WHEN COLUMN_KEY = 'PRI' THEN 1 ELSE 0 END AS pk, " +
        'ORDINAL_POSITION AS cid ' +
        'FROM INFORMATION_SCHEMA.COLUMNS ' +
        'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ' +
        'ORDER BY ORDINAL_POSITION',
      fixedArgs: [table],
    };
  }

  const smLit = /^SELECT\s+1\s+FROM\s+sqlite_master\s+WHERE\s+type\s*=\s*'table'\s+AND\s+name\s*=\s*'([^']+)'\s*$/i.exec(
    s0
  );
  if (smLit) {
    return {
      sql:
        "SELECT 1 AS `1` FROM information_schema.tables WHERE table_schema = DATABASE() " +
        "AND table_type = 'BASE TABLE' AND table_name = ? LIMIT 1",
      fixedArgs: [smLit[1]],
    };
  }

  if (
    /^SELECT\s+1\s+FROM\s+sqlite_master\s+WHERE\s+type\s*=\s*'table'\s+AND\s+name\s*=\s*\?\s*$/i.test(
      s0
    )
  ) {
    return {
      sql:
        "SELECT 1 AS `1` FROM information_schema.tables WHERE table_schema = DATABASE() " +
        "AND table_type = 'BASE TABLE' AND table_name = ? LIMIT 1",
      fixedArgs: null,
    };
  }

  const smNames = /^SELECT\s+name\s+FROM\s+sqlite_master\s+WHERE\s+type\s*=\s*'table'\s+AND\s+name\s+NOT\s+LIKE\s+'sqlite_%'\s*$/i.exec(
    s0
  );
  if (smNames) {
    return {
      sql:
        'SELECT TABLE_NAME AS name FROM information_schema.tables ' +
        "WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' " +
        "ORDER BY TABLE_NAME",
      fixedArgs: [],
    };
  }

  s = s.replace(/\bINSERT\s+OR\s+REPLACE\s+INTO\b/gi, 'REPLACE INTO');
  s = s.replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi, 'INSERT IGNORE INTO');
  /* SQLite-only collation; MySQL 8 + utf8mb4 */
  s = s.replace(/\bCOLLATE\s+NOCASE\b/gi, 'COLLATE utf8mb4_unicode_ci');
  /* SQLite CAST(... AS REAL); MariaDB needs DOUBLE/DECIMAL */
  s = s.replace(/\bCAST\s*\(\s*([^)]+?)\s+AS\s+REAL\s*\)/gi, 'CAST($1 AS DOUBLE)');

  s = adaptSqliteUpsertToMysql(s);

  return { sql: s, fixedArgs: null };
}

/**
 * SQLite UPSERT → MySQL/MariaDB ON DUPLICATE KEY UPDATE syntax.
 * Uses VALUES(col) for broad compatibility (including MariaDB).
 */
export function adaptSqliteUpsertToMysql(sql) {
  let s = String(sql || '');
  if (!/\bON\s+CONFLICT\b/i.test(s)) return s;
  s = s.replace(
    /\)\s*ON\s+CONFLICT\s*\([^)]*\)\s*DO\s+UPDATE\s+SET\s*/gi,
    ') ON DUPLICATE KEY UPDATE '
  );
  s = s.replace(/\bexcluded\.([a-z_][a-z0-9_]*)\b/gi, (_m, col) => `VALUES(${col})`);
  return s;
}
