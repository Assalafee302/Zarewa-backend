/**
 * Adapts the canonical DDL in schemaSql.js (SQLite-oriented comments) for MySQL 8.
 */
export function sqliteDdlToMysql(ddl) {
  let s = String(ddl || '');
  s = s.replace(
    /CREATE TABLE IF NOT EXISTS treasury_accounts \(\s*\n\s*id INTEGER PRIMARY KEY AUTOINCREMENT,/i,
    'CREATE TABLE IF NOT EXISTS treasury_accounts (\n  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,'
  );
  s = s.replace(/\bCREATE UNIQUE INDEX IF NOT EXISTS\b/gi, 'CREATE UNIQUE INDEX');
  s = s.replace(/\bCREATE INDEX IF NOT EXISTS\b/gi, 'CREATE INDEX');
  /* SQLite partial indexes — not supported in MySQL */
  s = s.replace(/\)\s*WHERE\b[\s\S]*?;/gi, ');');
  s = mapTextColumnsForMysql(s);
  s = escapeMysqlReservedColumnNames(s);
  s = addMysqlIndexKeyLengths(s);
  return s;
}

function escapeMysqlReservedColumnNames(sql) {
  return sql.replace(/(^|\n)(\s*)key(\s+VARCHAR|\s+MEDIUMTEXT)/gim, '$1$2`key`$3');
}

/**
 * Maps a SQLite-style column name that used TEXT to a MySQL column type (no "TEXT" — avoids DEFAULT restrictions).
 */
export function mysqlTypeForSqliteTextColumnName(col) {
  if (/_id$|_ref$|_no$|_key$|_token$|^id$|^key$/i.test(col)) {
    return 'VARCHAR(128)';
  }
  if (/_json$/i.test(col)) {
    return 'MEDIUMTEXT';
  }
  if (/_hash$/i.test(col)) {
    return 'VARCHAR(512)';
  }
  if (/_note$/i.test(col) || /_remark$/i.test(col)) {
    return 'MEDIUMTEXT';
  }
  if (
    /\b(json|b64|payload|lines|profile_json|details|html|sheet|sql|query|reason|evidence|blob|template|definition|markdown|raw|note|data|export|pack|bundle)\b|dashboard|crm_|attachment|body|summary|remark|config|description|content|_profile$/i.test(
      col
    )
  ) {
    return 'MEDIUMTEXT';
  }
  return 'VARCHAR(100)';
}

/** SQLite TEXT → VARCHAR or MEDIUMTEXT so InnoDB can index / foreign-key efficiently. */
function mapTextColumnsForMysql(sql) {
  return sql.replace(/\b([a-z_][a-z0-9_]*)\s+TEXT\b/gi, (full, col) => {
    return `${col} ${mysqlTypeForSqliteTextColumnName(col)}`;
  });
}

/**
 * InnoDB cannot index full TEXT/BLOB without a prefix; SQLite TEXT indexes need explicit lengths in MySQL.
 */
function addMysqlIndexKeyLengths(sql) {
  let out = sql.replace(
    /\bCREATE UNIQUE INDEX (\w+)\s+ON\s+(\w+)\s*\(\s*([\s\S]*?)\s*\)/gi,
    (full, idxName, tableName, colList) => formatIndex(idxName, tableName, colList, true)
  );
  out = out.replace(/\bCREATE INDEX (\w+)\s+ON\s+(\w+)\s*\(\s*([\s\S]*?)\s*\)/gi, (full, idxName, tableName, colList) =>
    formatIndex(idxName, tableName, colList, false)
  );
  return out;
}

function indexColumnNeedsPrefix(col) {
  const c = String(col || '').toLowerCase();
  if (c === 'treasury_account_id') return false;
  if (
    /_ngn$|_kg$|qty|amount|balance|count|sort_order|^active$|^archived$|line_no|precision|version|day_|month_|year_|hour|minute|second|flag|posted|registered|pending|enabled|locked|required/i.test(
      c
    )
  ) {
    return false;
  }
  return true;
}

function formatIndex(idxName, tableName, colList, unique) {
  const inner = String(colList)
    .split(',')
    .map((p) => {
      const t = p.trim();
      if (!t) return t;
      if (/\(\d+\)\s*$/i.test(t) || /\(\d+\)\s+(ASC|DESC)\s*$/i.test(t)) return t;
      const m = t.match(/^(\w+)(\s+(?:ASC|DESC))?$/i);
      if (!m) return t;
      const col = m[1];
      const dir = m[2] || '';
      if (indexColumnNeedsPrefix(col)) {
        return `${col}(64)${dir}`;
      }
      return `${col}${dir}`;
    })
    .join(', ');
  const kind = unique ? 'CREATE UNIQUE INDEX' : 'CREATE INDEX';
  return `${kind} ${idxName} ON ${tableName}(${inner})`;
}
