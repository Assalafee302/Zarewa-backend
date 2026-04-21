import { mysqlTypeForSqliteTextColumnName } from './schemaMysqlTransform.js';

/**
 * Rewrites SQLite-oriented DDL fragments (e.g. migrate.js `db.exec`) for MySQL.
 * MySQL forbids DEFAULT (non-NULL literals) on TEXT/BLOB/MEDIUMTEXT, so those become VARCHAR.
 * @param {string} sql
 * @param {unknown[]} args arguments passed to .run/.get/.all (may be mutated for PRAGMA rewrite)
 * @returns {{ sql: string, args: unknown[] }}
 */
export function adaptExecSqlForMysql(sql) {
  let s = String(sql || '');
  s = s.replace(/\bCREATE UNIQUE INDEX IF NOT EXISTS\b/gi, 'CREATE UNIQUE INDEX');
  s = s.replace(/\bCREATE INDEX IF NOT EXISTS\b/gi, 'CREATE INDEX');
  /* SQLite partial indexes — not supported in MySQL */
  s = s.replace(/\)\s*WHERE\b[\s\S]*?;/gi, ');');
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
  return s;
}

export function adaptSqlForMysql(sql, args) {
  const s0 = String(sql || '').trim();
  let s = adaptExecSqlForMysql(s0);
  const outArgs = args != null ? [...args] : [];

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
      args: [table],
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
      args: [smLit[1]],
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
      args: outArgs,
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
      args: [],
    };
  }

  s = s.replace(/\bINSERT\s+OR\s+REPLACE\s+INTO\b/gi, 'REPLACE INTO');
  s = s.replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/gi, 'INSERT IGNORE INTO');
  /* SQLite-only collation; MySQL 8 + utf8mb4 */
  s = s.replace(/\bCOLLATE\s+NOCASE\b/gi, 'COLLATE utf8mb4_unicode_ci');

  s = adaptSqliteUpsertToMysql(s);

  return { sql: s, args: outArgs };
}

/**
 * SQLite UPSERT → MySQL 8.0.19+ row alias syntax.
 */
export function adaptSqliteUpsertToMysql(sql) {
  let s = String(sql || '');
  if (!/\bON\s+CONFLICT\b/i.test(s)) return s;
  s = s.replace(/\)\s*ON\s+CONFLICT\s*\([^)]*\)\s*DO\s+UPDATE\s+SET\s*/gi, ') AS ex ON DUPLICATE KEY UPDATE ');
  s = s.replace(/\bexcluded\./gi, 'ex.');
  return s;
}
