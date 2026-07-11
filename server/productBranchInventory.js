/**
 * Branch-scoped non-coil inventory vs global coil catalogue SKUs.
 */
import { DEFAULT_BRANCH_ID, listBranches } from './branches.js';

export const GLOBAL_COIL_PRODUCT_IDS = new Set(['COIL-ALU', 'PRD-102']);

function parseDashboardAttrs(row) {
  try {
    return JSON.parse(row?.dashboard_attrs_json || '{}');
  } catch {
    return {};
  }
}

export function isGlobalCoilCatalogProductId(productId, dashboardAttrs = null) {
  const pid = String(productId || '').trim();
  if (GLOBAL_COIL_PRODUCT_IDS.has(pid)) return true;
  const model = String(dashboardAttrs?.inventoryModel || '').trim();
  return model === 'coil_kg';
}

export function isGlobalCoilCatalogRow(row) {
  if (!row) return false;
  return isGlobalCoilCatalogProductId(row.product_id, parseDashboardAttrs(row));
}

function productsPkColumns(db) {
  const cols = db.prepare(`PRAGMA table_info(products)`).all();
  return cols.filter((c) => c.pk).map((c) => c.name);
}

export function productsTableHasBranchCompositePk(db) {
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='products'`).get()) {
    return false;
  }
  const pk = productsPkColumns(db);
  return pk.includes('branch_id') && pk.includes('product_id');
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} productId
 * @param {string} workspaceBranchId
 */
function productAllowsNegativeStock(productId, row) {
  const pid = String(productId || '').trim();
  if (/^ACC-/i.test(pid)) return true;
  if (!row || !/^STONE-/i.test(pid)) return false;
  const attrs = parseDashboardAttrs(row);
  if (attrs.stoneFlatsheet) return true;
  if (attrs.inventoryModel === 'stone_meter') return true;
  if (String(row.unit || '').toLowerCase() === 'm' && attrs.stoneDesign) return true;
  return /^STONE-/i.test(pid) && !/^STONE-FS-/i.test(pid);
}

/**
 * @returns {number | null} on-hand qty for branch-scoped row, or null if missing
 */
export function getProductStockLevelForBranch(db, productId, branchId) {
  const row = getProductRowForWorkspace(db, productId, branchId);
  if (!row) return null;
  return Number(row.stock_level) || 0;
}

/**
 * Branch-scoped stock delta.
 * Negatives are blocked by default. Pass `{ allowNegative: true }` only for known fulfilment paths
 * that intentionally overdraw accessories/stone (legacy). Prefer preventing oversell.
 * @returns {boolean} whether a row was updated
 */
export function adjustProductStockForBranch(db, productId, delta, branchId, opts = {}) {
  const pid = String(productId || '').trim();
  if (!pid) return false;
  const row = getProductRowForWorkspace(db, pid, branchId);
  if (!row) return false;
  const pb = String(row.branch_id ?? '').trim();
  const raw = Number(row.stock_level) + Number(delta || 0);
  const allowNegative =
    opts.allowNegative === true ||
    (opts.allowNegative !== false &&
      productAllowsNegativeStock(pid, row) &&
      process.env.ZAREWA_BLOCK_NEGATIVE_STOCK !== '1');
  if (!allowNegative && raw < -1e-9) {
    throw new Error(
      `Insufficient stock for ${pid} (on hand ${Number(row.stock_level) || 0}, change ${Number(delta) || 0}).`
    );
  }
  const next = allowNegative ? raw : Math.max(0, raw);
  db.prepare(`UPDATE products SET stock_level = ? WHERE product_id = ? AND branch_id = ?`).run(
    next,
    pid,
    pb
  );
  return true;
}

/**
 * @returns {boolean} whether a row was updated
 */
export function bumpProductStockLevel(db, productId, branchId, delta, opts = {}) {
  return adjustProductStockForBranch(db, productId, delta, branchId, opts);
}

export function getProductRowForWorkspace(db, productId, workspaceBranchId) {
  const pid = String(productId || '').trim();
  const wb = String(workspaceBranchId || '').trim();
  if (!pid) return null;
  if (isGlobalCoilCatalogProductId(pid)) {
    const globalRow = db
      .prepare(
        `SELECT * FROM products WHERE product_id = ? AND (branch_id IS NULL OR TRIM(COALESCE(branch_id,'')) = '') LIMIT 1`
      )
      .get(pid);
    if (globalRow) return globalRow;
    // Legacy/seed rows may still carry a home branch_id on global coil SKUs.
    if (wb) {
      const branchRow = db.prepare(`SELECT * FROM products WHERE product_id = ? AND branch_id = ?`).get(pid, wb);
      if (branchRow) return branchRow;
    }
    return db.prepare(`SELECT * FROM products WHERE product_id = ? LIMIT 1`).get(pid) || null;
  }
  if (!wb) {
    return getProductRowForWorkspace(db, pid, DEFAULT_BRANCH_ID);
  }
  return db.prepare(`SELECT * FROM products WHERE product_id = ? AND branch_id = ?`).get(pid, wb);
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function migrateProductsBranchCompositeInventory(db) {
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='products'`).get()) {
    return;
  }
  if (productsTableHasBranchCompositePk(db)) {
    repairNonCoilProductBranchAssignment(db);
    return;
  }

  const branches = listBranches(db).map((b) => b.id).filter(Boolean);
  if (!branches.length) {
    branches.push('BR-KD', 'BR-YL', 'BR-MDG');
  }

  const sourceRows = db.prepare(`SELECT * FROM products`).all();
  /** @type {typeof sourceRows} */
  const expanded = [];

  for (const row of sourceRows) {
    if (isGlobalCoilCatalogRow(row)) {
      expanded.push({ ...row, branch_id: '' });
      continue;
    }
    const home = String(row.branch_id ?? '').trim() || 'BR-KD';
    const stock = Number(row.stock_level) || 0;
    for (const br of branches) {
      expanded.push({
        ...row,
        branch_id: br,
        stock_level: br === home ? stock : 0,
      });
    }
  }

  db.transaction(() => {
    db.exec(`DROP TABLE IF EXISTS products__branch_new`);
    db.exec(`
      CREATE TABLE products__branch_new (
        product_id TEXT NOT NULL,
        name TEXT NOT NULL,
        stock_level REAL NOT NULL DEFAULT 0,
        unit TEXT NOT NULL,
        low_stock_threshold REAL NOT NULL DEFAULT 0,
        reorder_qty REAL NOT NULL DEFAULT 0,
        gauge TEXT,
        colour TEXT,
        material_type TEXT,
        dashboard_attrs_json TEXT,
        branch_id TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (branch_id, product_id)
      )
    `);
    const ins = db.prepare(
      `INSERT OR REPLACE INTO products__branch_new (
        product_id, name, stock_level, unit, low_stock_threshold, reorder_qty,
        gauge, colour, material_type, dashboard_attrs_json, branch_id
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    );
    for (const r of expanded) {
      ins.run(
        r.product_id,
        r.name,
        r.stock_level,
        r.unit,
        r.low_stock_threshold,
        r.reorder_qty,
        r.gauge,
        r.colour,
        r.material_type,
        r.dashboard_attrs_json,
        String(r.branch_id ?? '').trim()
      );
    }
    db.exec(`DROP TABLE products`);
    db.exec(`ALTER TABLE products__branch_new RENAME TO products`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ws_products_branch ON products(branch_id)`);
  })();

  repairNonCoilProductBranchAssignment(db);
  rebalanceWipBalancesForProducts(db, branches);
}

/** Undo mistaken global catalogue stamp on accessories / stone (keep coils global). */
function repairNonCoilProductBranchAssignment(db) {
  const rows = db.prepare(`SELECT product_id, branch_id, dashboard_attrs_json FROM products`).all();
  for (const row of rows) {
    if (!isGlobalCoilCatalogRow(row) && String(row.branch_id ?? '').trim() === '') {
      db.prepare(`UPDATE products SET branch_id = 'BR-KD' WHERE product_id = ? AND branch_id = ''`).run(
        row.product_id
      );
    }
  }
  // Global coil SKUs must remain catalogue-scoped (empty branch_id), even when seed defaulted them to a home branch.
  for (const pid of GLOBAL_COIL_PRODUCT_IDS) {
    const branched = db
      .prepare(
        `SELECT product_id, branch_id, stock_level FROM products
         WHERE product_id = ? AND TRIM(COALESCE(branch_id,'')) != ''`
      )
      .all(pid);
    if (!branched.length) continue;
    const globalExists = db
      .prepare(
        `SELECT 1 AS ok FROM products WHERE product_id = ? AND (branch_id IS NULL OR TRIM(COALESCE(branch_id,'')) = '') LIMIT 1`
      )
      .get(pid);
    if (globalExists) {
      for (const r of branched) {
        db.prepare(`DELETE FROM products WHERE product_id = ? AND branch_id = ?`).run(pid, r.branch_id);
      }
      continue;
    }
    const keep = branched[0];
    const stockSum = branched.reduce((s, r) => s + (Number(r.stock_level) || 0), 0);
    db.prepare(`UPDATE products SET branch_id = '', stock_level = ? WHERE product_id = ? AND branch_id = ?`).run(
      stockSum,
      pid,
      keep.branch_id
    );
    for (const r of branched.slice(1)) {
      db.prepare(`DELETE FROM products WHERE product_id = ? AND branch_id = ?`).run(pid, r.branch_id);
    }
  }
}

function rebalanceWipBalancesForProducts(db, branches) {
  if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='wip_balances'`).get()) {
    return;
  }
  const hasBb = db.prepare(`PRAGMA table_info(wip_balances)`).all().some((c) => c.name === 'branch_id');
  if (!hasBb) return;

  for (const br of branches) {
    const products = db.prepare(`SELECT product_id FROM products WHERE branch_id = ?`).all(br);
    for (const p of products) {
      const exists = db
        .prepare(`SELECT 1 FROM wip_balances WHERE branch_id = ? AND product_id = ?`)
        .get(br, p.product_id);
      if (!exists) {
        db.prepare(`INSERT INTO wip_balances (branch_id, product_id, qty) VALUES (?,?,0)`).run(br, p.product_id);
      }
    }
  }

  const orphanWip = db
    .prepare(
      `SELECT w.branch_id, w.product_id FROM wip_balances w
       WHERE NOT EXISTS (
         SELECT 1 FROM products p
         WHERE p.product_id = w.product_id
           AND TRIM(COALESCE(p.branch_id,'')) = TRIM(COALESCE(w.branch_id,''))
       )`
    )
    .all();
  for (const w of orphanWip) {
    const match = db
      .prepare(`SELECT branch_id FROM products WHERE product_id = ? LIMIT 1`)
      .get(w.product_id);
    if (match) {
      db.prepare(`UPDATE wip_balances SET branch_id = ? WHERE product_id = ?`).run(
        String(match.branch_id ?? '').trim(),
        w.product_id
      );
    }
  }
}
