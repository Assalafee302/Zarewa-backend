/**
 * Phase 1 accessory/stone schema + catalogue fixes (no balance rewrites of posted movements).
 * Physical opening reset is preview/post via openingStockResetOps — not auto-run here.
 */
import { STONE_COATED_MATERIAL_TYPE_ID } from '../inventoryConstants.js';

function tableColumnSet(db, name) {
  try {
    const rows = db
      .prepare(
        `SELECT column_name FROM information_schema.columns
         WHERE table_schema = DATABASE() AND table_name = ?`
      )
      .all(name);
    if (rows.length) {
      return new Set(
        rows
          .map((c) => String(c.column_name ?? c.COLUMN_NAME ?? '').toLowerCase())
          .filter(Boolean)
      );
    }
  } catch {
    /* sqlite */
  }
  try {
    return new Set(db.prepare(`PRAGMA table_info(${name})`).all().map((c) => String(c.name).toLowerCase()));
  } catch {
    return new Set();
  }
}

export function migrateAccessoryStonePhase1(db) {
  migrateNegativeStockApprovals(db);
  migrateFlatsheetProductsToSheetUnit(db);
  migrateShingleSurvivorProfile(db);
  ensureMissingFlatsheetSku(db);
}

function migrateNegativeStockApprovals(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS negative_stock_approvals (
      id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL,
      product_id TEXT NOT NULL,
      job_id TEXT,
      ref TEXT,
      qty_requested REAL NOT NULL,
      stock_before REAL,
      reason TEXT NOT NULL,
      approved_by_user_id TEXT NOT NULL,
      approved_by_name TEXT,
      approved_at_iso TEXT NOT NULL,
      consumed_at_iso TEXT,
      consumed_by_user_id TEXT,
      status TEXT NOT NULL DEFAULT 'approved'
    );
    CREATE INDEX IF NOT EXISTS idx_neg_stock_appr_branch
      ON negative_stock_approvals(branch_id, approved_at_iso DESC);
    CREATE INDEX IF NOT EXISTS idx_neg_stock_appr_status
      ON negative_stock_approvals(status, approved_at_iso DESC);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS opening_stock_reset_runs (
      id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL,
      preview_json TEXT NOT NULL,
      posted_at_iso TEXT,
      posted_by_user_id TEXT,
      posted_by_name TEXT,
      status TEXT NOT NULL DEFAULT 'preview',
      note TEXT
    );
  `);
}

/**
 * Convert FS product metadata to sheet UOM. Does NOT rewrite stock_level or movements.
 * Balances are set later via dated ADJUSTMENT from the 5 Oct physical count preview.
 */
function migrateFlatsheetProductsToSheetUnit(db) {
  const cols = tableColumnSet(db, 'products');
  if (!cols.has('product_id')) return;
  const rows = db
    .prepare(
      `SELECT product_id, branch_id, unit, dashboard_attrs_json
       FROM products WHERE product_id LIKE 'STONE-FS-%'`
    )
    .all();
  const upd = db.prepare(
    `UPDATE products SET unit = ?, base_unit = ?, dashboard_attrs_json = ?
     WHERE product_id = ? AND branch_id = ?`
  );
  for (const r of rows) {
    let attrs = {};
    try {
      attrs = JSON.parse(r.dashboard_attrs_json || '{}') || {};
    } catch {
      attrs = {};
    }
    attrs.stoneFlatsheet = true;
    attrs.inventoryModel = attrs.inventoryModel || 'stone_meter';
    attrs.stockUnit = 'sheet';
    const unit = 'sheet';
    const baseUnit = cols.has('base_unit') ? unit : undefined;
    if (baseUnit != null) {
      upd.run(unit, baseUnit, JSON.stringify(attrs), r.product_id, r.branch_id);
    } else {
      db.prepare(
        `UPDATE products SET unit = ?, dashboard_attrs_json = ?
         WHERE product_id = ? AND branch_id = ?`
      ).run(unit, JSON.stringify(attrs), r.product_id, r.branch_id);
    }
  }
}

/** Survivor profile = Shingle (PROF-010). Deactivate Single (PROF-016). */
function migrateShingleSurvivorProfile(db) {
  try {
    db.prepare(
      `UPDATE setup_profiles SET name = 'Shingle', active = 1, material_type_id = ?
       WHERE profile_id = 'PROF-010'`
    ).run(STONE_COATED_MATERIAL_TYPE_ID);
  } catch {
    /* table missing in unit tests */
  }
  try {
    db.prepare(`UPDATE setup_profiles SET active = 0 WHERE profile_id = 'PROF-016'`).run();
  } catch {
    /* ignore */
  }
}

/** Ensure 1.4 m red mix black FS SKU exists (was missing on KD). */
function ensureMissingFlatsheetSku(db) {
  const branches = db.prepare(`SELECT id FROM branches WHERE IFNULL(active,1) != 0`).all();
  const pid = 'STONE-FS-red-mix-black-1p4m';
  const name = 'Stone flatsheet Red Mix Black / 1.4 m';
  const dash = JSON.stringify({
    inventoryModel: 'stone_meter',
    stoneFlatsheet: true,
    stoneFlatsheetLengthM: 1.4,
    stoneFlatsheetColour: 'Red Mix Black',
    materialTypeId: STONE_COATED_MATERIAL_TYPE_ID,
    stockUnit: 'sheet',
  });
  for (const b of branches) {
    const bid = String(b.id || '').trim();
    if (!bid) continue;
    const exists = db
      .prepare(`SELECT 1 AS ok FROM products WHERE product_id = ? AND branch_id = ?`)
      .get(pid, bid);
    if (exists) continue;
    try {
      db.prepare(
        `INSERT INTO products (product_id, name, stock_level, unit, base_unit, low_stock_threshold, reorder_qty, gauge, colour, material_type, dashboard_attrs_json, branch_id)
         VALUES (?,?,0,'sheet','sheet',0,0,'',?,?,?,?)`
      ).run(pid, name, 'Red Mix Black', 'Stone coated', dash, bid);
    } catch {
      try {
        db.prepare(
          `INSERT INTO products (product_id, name, stock_level, unit, low_stock_threshold, reorder_qty, gauge, colour, material_type, dashboard_attrs_json, branch_id)
           VALUES (?,?,0,'sheet',0,0,'',?,?,?,?)`
        ).run(pid, name, 'Red Mix Black', 'Stone coated', dash, bid);
      } catch {
        /* ignore */
      }
    }
  }
}
