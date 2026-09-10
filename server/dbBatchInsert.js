/**
 * Multi-row INSERT helpers — one synckit/MySQL round-trip per batch instead of N.
 */

const DEFAULT_BATCH = 100;

/**
 * @param {object} db
 * @param {string} insertSqlPrefix INSERT INTO t (cols) — without VALUES
 * @param {number} placeholdersPerRow
 * @param {unknown[][]} rows each row is an args array matching placeholdersPerRow
 * @param {{ batchSize?: number }} [opts]
 * @returns {{ changes: number; batches: number }}
 */
export function batchInsertValues(db, insertSqlPrefix, placeholdersPerRow, rows, opts = {}) {
  const list = Array.isArray(rows) ? rows : [];
  // Throw rather than skip. These batches carry ledger and PO lines, so a row whose
  // arity drifted from the column list — a column added on one push path but not
  // another — must fail loudly instead of disappearing from a money table unnoticed.
  list.forEach((r, i) => {
    if (!Array.isArray(r) || r.length !== placeholdersPerRow) {
      throw new Error(
        `batchInsertValues: row ${i} has ${Array.isArray(r) ? r.length : typeof r} args, expected ${placeholdersPerRow}`
      );
    }
  });
  if (!list.length) return { changes: 0, batches: 0, rows: 0 };

  const batchSize = Math.min(500, Math.max(1, Number(opts.batchSize) || DEFAULT_BATCH));
  const ph = `(${Array.from({ length: placeholdersPerRow }, () => '?').join(',')})`;
  let changes = 0;
  let batches = 0;

  for (let i = 0; i < list.length; i += batchSize) {
    const chunk = list.slice(i, i + batchSize);
    const sql = `${insertSqlPrefix} VALUES ${chunk.map(() => ph).join(',')}`;
    const r = db.prepare(sql).run(...chunk.flat());
    // Report what the driver reported. Falling back to chunk.length here would turn a
    // batch that wrote nothing into one that looks fully applied.
    changes += Number(r?.changes) || 0;
    batches += 1;
  }
  return { changes, batches, rows: list.length };
}

/**
 * Prefer a single worker round-trip when multi-value INSERT is awkward (per-row SQL differs).
 * @param {object} db
 * @param {string} sql
 * @param {unknown[][]} rowsArgs
 * @param {{ batchSize?: number }} [opts]
 */
export function batchRunSameSql(db, sql, rowsArgs, opts = {}) {
  const list = Array.isArray(rowsArgs) ? rowsArgs : [];
  if (!list.length) return { changes: 0, batches: 0, rows: 0 };
  if (typeof db.runMany !== 'function') {
    let changes = 0;
    const stmt = db.prepare(sql);
    for (const args of list) {
      const r = stmt.run(...args);
      changes += Number(r?.changes) || 0;
    }
    return { changes, batches: list.length, rows: list.length };
  }
  const batchSize = Math.min(500, Math.max(1, Number(opts.batchSize) || DEFAULT_BATCH));
  let changes = 0;
  let batches = 0;
  for (let i = 0; i < list.length; i += batchSize) {
    const chunk = list.slice(i, i + batchSize);
    const r = db.runMany(chunk.map((args) => ({ sql, args })));
    // Same as above: a real 0 must stay 0, or a no-op batch reads as a full write.
    changes += Number(r?.changes) || 0;
    batches += 1;
  }
  return { changes, batches, rows: list.length };
}
