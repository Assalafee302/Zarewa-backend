/**
 * Stock movement insert + branch_id resolution/backfill.
 */
import { DEFAULT_BRANCH_ID } from './branches.js';

function hasColumn(db, table, col) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  } catch {
    return false;
  }
}

/**
 * Infer workspace branch from movement ref / product when caller omits branchId.
 * @param {import('better-sqlite3').Database} db
 * @param {{ ref?: string, productID?: string, product_id?: string }} entry
 */
export function resolveStockMovementBranchId(db, entry) {
  const ref = String(entry?.ref ?? '').trim();
  const productId = String(entry?.productID ?? entry?.product_id ?? '').trim();

  const tryBranch = (sql, ...args) => {
    try {
      const row = db.prepare(sql).get(...args);
      const bid = String(row?.branch_id ?? '').trim();
      return bid || null;
    } catch {
      return null;
    }
  };

  if (ref) {
    const fromRef =
      tryBranch(`SELECT branch_id FROM production_jobs WHERE job_id = ?`, ref) ||
      tryBranch(`SELECT branch_id FROM purchase_orders WHERE po_id = ?`, ref) ||
      tryBranch(`SELECT branch_id FROM quotations WHERE id = ?`, ref) ||
      tryBranch(`SELECT branch_id FROM deliveries WHERE id = ?`, ref) ||
      tryBranch(`SELECT branch_id FROM material_incidents WHERE id = ?`, ref) ||
      tryBranch(`SELECT branch_id FROM coil_lots WHERE coil_no = ?`, ref);
    if (fromRef) return fromRef;
  }

  if (productId && hasColumn(db, 'products', 'branch_id')) {
    try {
      const row = db
        .prepare(
          `SELECT branch_id FROM products WHERE product_id = ? AND TRIM(COALESCE(branch_id,'')) != '' LIMIT 1`
        )
        .get(productId);
      const bid = String(row?.branch_id ?? '').trim();
      if (bid) return bid;
    } catch {
      /* ignore */
    }
  }

  return DEFAULT_BRANCH_ID;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} entry requires `id`, `type`; optional branchId, atISO, ref, productID, qty, detail, dateISO, unitPriceNgn, valueNgn
 */
export function insertStockMovementTx(db, entry) {
  const id = String(entry?.id ?? '').trim();
  if (!id) throw new Error('Stock movement id is required.');
  const atISO = String(entry.atISO || new Date().toISOString()).slice(0, 19);
  const branchId =
    String(entry.branchId ?? entry.branch_id ?? resolveStockMovementBranchId(db, entry) ?? '').trim() ||
    DEFAULT_BRANCH_ID;
  const dateISO = String(entry.dateISO ?? atISO).slice(0, 10);

  if (hasColumn(db, 'stock_movements', 'branch_id')) {
    db.prepare(
      `INSERT INTO stock_movements (
        id, at_iso, type, ref, product_id, qty, detail, date_iso, unit_price_ngn, value_ngn, branch_id
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      id,
      atISO,
      entry.type,
      entry.ref ?? null,
      entry.productID ?? entry.product_id ?? null,
      entry.qty ?? null,
      entry.detail ?? null,
      dateISO,
      entry.unitPriceNgn ?? null,
      entry.valueNgn ?? null,
      branchId
    );
  } else {
    db.prepare(
      `INSERT INTO stock_movements (
        id, at_iso, type, ref, product_id, qty, detail, date_iso, unit_price_ngn, value_ngn
      ) VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run(
      id,
      atISO,
      entry.type,
      entry.ref ?? null,
      entry.productID ?? entry.product_id ?? null,
      entry.qty ?? null,
      entry.detail ?? null,
      dateISO,
      entry.unitPriceNgn ?? null,
      entry.valueNgn ?? null
    );
  }
  return id;
}

/** Add branch_id to stock_movements and backfill from linked entities. */
export function migrateStockMovementsBranchId(db) {
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='stock_movements'`).get()) {
    return;
  }
  if (!hasColumn(db, 'stock_movements', 'branch_id')) {
    db.exec(`ALTER TABLE stock_movements ADD COLUMN branch_id TEXT NOT NULL DEFAULT ''`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_stock_movements_branch ON stock_movements(branch_id)`);

  const backfills = [
    `UPDATE stock_movements SET branch_id = (
       SELECT branch_id FROM production_jobs WHERE job_id = stock_movements.ref
     ) WHERE TRIM(COALESCE(branch_id,'')) = '' AND ref IN (SELECT job_id FROM production_jobs)`,
    `UPDATE stock_movements SET branch_id = (
       SELECT branch_id FROM purchase_orders WHERE po_id = stock_movements.ref
     ) WHERE TRIM(COALESCE(branch_id,'')) = '' AND ref IN (SELECT po_id FROM purchase_orders)`,
    `UPDATE stock_movements SET branch_id = (
       SELECT branch_id FROM quotations WHERE id = stock_movements.ref
     ) WHERE TRIM(COALESCE(branch_id,'')) = '' AND ref IN (SELECT id FROM quotations)`,
    `UPDATE stock_movements SET branch_id = (
       SELECT branch_id FROM deliveries WHERE id = stock_movements.ref
     ) WHERE TRIM(COALESCE(branch_id,'')) = '' AND ref IN (SELECT id FROM deliveries)`,
  ];

  if (hasColumn(db, 'material_incidents', 'branch_id')) {
    backfills.push(
      `UPDATE stock_movements SET branch_id = (
         SELECT branch_id FROM material_incidents WHERE id = stock_movements.ref
       ) WHERE TRIM(COALESCE(branch_id,'')) = '' AND ref IN (SELECT id FROM material_incidents)`
    );
  }
  if (hasColumn(db, 'coil_lots', 'branch_id')) {
    backfills.push(
      `UPDATE stock_movements SET branch_id = (
         SELECT branch_id FROM coil_lots WHERE coil_no = stock_movements.ref
       ) WHERE TRIM(COALESCE(branch_id,'')) = '' AND ref IN (SELECT coil_no FROM coil_lots)`
    );
  }
  if (hasColumn(db, 'products', 'branch_id')) {
    backfills.push(
      `UPDATE stock_movements SET branch_id = (
         SELECT p.branch_id FROM products p
         WHERE p.product_id = stock_movements.product_id
           AND TRIM(COALESCE(p.branch_id,'')) != ''
         LIMIT 1
       ) WHERE TRIM(COALESCE(branch_id,'')) = '' AND product_id IS NOT NULL AND TRIM(product_id) != ''`
    );
  }

  for (const sql of backfills) {
    try {
      db.exec(sql);
    } catch {
      /* table may be absent on partial installs */
    }
  }

  db.prepare(`UPDATE stock_movements SET branch_id = ? WHERE TRIM(COALESCE(branch_id,'')) = ''`).run(
    DEFAULT_BRANCH_ID
  );
}
