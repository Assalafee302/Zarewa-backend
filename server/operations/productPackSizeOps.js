/**
 * Pack-size catalogue for ACC-/STONE- products (editable by OM/admin with history).
 */
import { listBranches } from '../branches.js';
import { identityPackSize } from '../../shared/lib/productUom.js';

function nowIso() {
  return new Date().toISOString();
}

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

export function migrateProductPackSizes(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS product_pack_sizes (
      id TEXT PRIMARY KEY,
      product_id TEXT NOT NULL,
      branch_id TEXT NOT NULL DEFAULT '',
      unit_code TEXT NOT NULL,
      factor_to_base REAL NOT NULL,
      label TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      UNIQUE (product_id, branch_id, unit_code)
    );
    CREATE TABLE IF NOT EXISTS product_pack_size_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at_iso TEXT NOT NULL,
      actor_user_id TEXT,
      actor_name TEXT,
      product_id TEXT NOT NULL,
      branch_id TEXT,
      unit_code TEXT NOT NULL,
      action TEXT NOT NULL,
      old_factor_to_base REAL,
      new_factor_to_base REAL,
      old_label TEXT,
      new_label TEXT,
      note TEXT
    );
  `);
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_product_pack_sizes_pid ON product_pack_sizes(product_id)`);
  } catch {
    /* already exists */
  }

  const productCols = tableColumnSet(db, 'products');
  if (productCols.size && !productCols.has('base_unit')) {
    db.exec(`ALTER TABLE products ADD COLUMN base_unit TEXT`);
  }
  try {
    db.prepare(
      `UPDATE products SET base_unit = unit
       WHERE (base_unit IS NULL OR TRIM(base_unit) = '')
         AND (product_id LIKE 'ACC-%' OR product_id LIKE 'STONE-%')`
    ).run();
  } catch {
    /* ignore */
  }

  const poCols = tableColumnSet(db, 'purchase_order_lines');
  if (poCols.size && !poCols.has('qty_unit')) {
    db.exec(`ALTER TABLE purchase_order_lines ADD COLUMN qty_unit TEXT`);
  }

  seedDefaultPackSizes(db);
}

const DEFAULT_PACKS = [
  {
    productId: 'ACC-DRIVE-SCREW-PACK',
    baseUnit: 'pack',
    sizes: [
      { unitCode: 'pack', factorToBase: 1, label: 'pack', sortOrder: 0 },
      { unitCode: 'carton', factorToBase: 30, label: 'carton (30 packs)', sortOrder: 10 },
    ],
  },
  {
    productId: 'ACC-TAPPING-SCREW-PCS',
    baseUnit: 'pcs',
    sizes: [
      { unitCode: 'pcs', factorToBase: 1, label: 'piece', sortOrder: 0 },
      { unitCode: 'piece', factorToBase: 1, label: 'piece', sortOrder: 1 },
      { unitCode: 'carton_2_5', factorToBase: 1250, label: 'carton 2.5"', sortOrder: 10 },
      { unitCode: 'carton_3', factorToBase: 1000, label: 'carton 3"', sortOrder: 20 },
    ],
  },
];

function seedDefaultPackSizes(db) {
  const has = db
    .prepare(`SELECT 1 AS ok FROM product_pack_sizes WHERE product_id = ? AND unit_code = ? LIMIT 1`);
  const ins = db.prepare(
    `INSERT INTO product_pack_sizes (id, product_id, branch_id, unit_code, factor_to_base, label, active, sort_order)
     VALUES (?,?, '',?,?,?,?,?)`
  );
  for (const def of DEFAULT_PACKS) {
    for (const s of def.sizes) {
      if (has.get(def.productId, s.unitCode)) continue;
      const id = `PPS-${def.productId}-${s.unitCode}`.slice(0, 80);
      try {
        ins.run(id, def.productId, s.unitCode, s.factorToBase, s.label || s.unitCode, 1, s.sortOrder || 0);
      } catch {
        /* unique race */
      }
    }
  }
}

/**
 * @returns {{ baseUnit: string, packSizes: { unitCode: string, factorToBase: number, label: string, active: boolean, sortOrder: number, id?: string }[] }}
 */
export function listPackSizesForProduct(db, productId, branchId = '') {
  const pid = String(productId || '').trim();
  if (!pid) return { baseUnit: 'unit', packSizes: [identityPackSize('unit')] };
  const bid = String(branchId || '').trim();
  let baseUnit = 'unit';
  try {
    const prow = bid
      ? db
          .prepare(`SELECT unit, base_unit FROM products WHERE product_id = ? AND branch_id = ?`)
          .get(pid, bid)
      : db.prepare(`SELECT unit, base_unit FROM products WHERE product_id = ? LIMIT 1`).get(pid);
    baseUnit = String(prow?.base_unit || prow?.unit || 'unit').trim() || 'unit';
  } catch {
    baseUnit = 'unit';
  }

  let rows = [];
  try {
    if (bid) {
      rows = db
        .prepare(
          `SELECT * FROM product_pack_sizes
           WHERE product_id = ? AND active != 0
             AND (branch_id IS NULL OR branch_id = '' OR branch_id = ?)
           ORDER BY CASE WHEN branch_id = ? THEN 0 ELSE 1 END, sort_order ASC, unit_code ASC`
        )
        .all(pid, bid, bid);
    } else {
      rows = db
        .prepare(
          `SELECT * FROM product_pack_sizes
           WHERE product_id = ? AND active != 0 AND (branch_id IS NULL OR branch_id = '')
           ORDER BY sort_order ASC, unit_code ASC`
        )
        .all(pid);
    }
  } catch {
    rows = [];
  }

  // Prefer branch-specific unit_code over global when both exist
  const byCode = new Map();
  for (const r of rows) {
    const code = String(r.unit_code || '').trim();
    if (!code) continue;
    const existing = byCode.get(code);
    if (!existing || (bid && String(r.branch_id || '').trim() === bid)) {
      byCode.set(code, r);
    }
  }
  const packSizes = [...byCode.values()].map((r) => ({
    id: r.id,
    unitCode: String(r.unit_code),
    factorToBase: Number(r.factor_to_base) || 1,
    label: String(r.label || r.unit_code),
    active: Boolean(r.active),
    sortOrder: Number(r.sort_order) || 0,
    branchId: r.branch_id || null,
  }));
  if (!packSizes.some((p) => p.unitCode.toLowerCase() === baseUnit.toLowerCase())) {
    packSizes.unshift({ ...identityPackSize(baseUnit), sortOrder: -1 });
  }
  return { baseUnit, packSizes };
}

/**
 * OM/admin upsert of a pack size row (+ history).
 */
export function upsertPackSize(db, payload, actor) {
  const productId = String(payload?.productId || payload?.product_id || '').trim();
  const unitCode = String(payload?.unitCode || payload?.unit_code || '')
    .trim()
    .toLowerCase();
  const factor = Number(payload?.factorToBase ?? payload?.factor_to_base);
  if (!productId || !unitCode) return { ok: false, error: 'productId and unitCode are required.' };
  if (!Number.isFinite(factor) || factor <= 0) {
    return { ok: false, error: 'factorToBase must be a positive number.' };
  }
  const branchId =
    payload?.branchId != null || payload?.branch_id != null
      ? String(payload.branchId ?? payload.branch_id ?? '').trim()
      : '';
  const label = String(payload?.label || unitCode).trim();
  const active = payload?.active === false || payload?.active === 0 ? 0 : 1;
  const sortOrder = Number(payload?.sortOrder ?? payload?.sort_order) || 0;
  const id =
    String(payload?.id || '').trim() ||
    `PPS-${productId}-${branchId || 'ALL'}-${unitCode}`.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80);

  const prev = db
    .prepare(
      `SELECT * FROM product_pack_sizes WHERE product_id = ? AND unit_code = ?
         AND IFNULL(branch_id,'') = ?`
    )
    .get(productId, unitCode, branchId || '');

  db.transaction(() => {
    if (prev) {
      db.prepare(
        `UPDATE product_pack_sizes SET factor_to_base = ?, label = ?, active = ?, sort_order = ?
         WHERE id = ?`
      ).run(factor, label, active, sortOrder, prev.id);
    } else {
      db.prepare(
        `INSERT INTO product_pack_sizes (id, product_id, branch_id, unit_code, factor_to_base, label, active, sort_order)
         VALUES (?,?,?,?,?,?,?,?)`
      ).run(id, productId, branchId, unitCode, factor, label, active, sortOrder);
    }
    db.prepare(
      `INSERT INTO product_pack_size_history (
         at_iso, actor_user_id, actor_name, product_id, branch_id, unit_code, action,
         old_factor_to_base, new_factor_to_base, old_label, new_label, note
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      nowIso(),
      actor?.id || null,
      actor?.name || actor?.displayName || null,
      productId,
      branchId,
      unitCode,
      prev ? 'update' : 'create',
      prev ? Number(prev.factor_to_base) : null,
      factor,
      prev?.label || null,
      label,
      String(payload?.note || '').trim() || null
    );
  })();

  return { ok: true, id: prev?.id || id, ...listPackSizesForProduct(db, productId, branchId || '') };
}

export function listPackSizeHistory(db, productId, limit = 50) {
  const pid = String(productId || '').trim();
  const lim = Math.min(200, Math.max(1, Number(limit) || 50));
  return db
    .prepare(
      `SELECT * FROM product_pack_size_history WHERE product_id = ? ORDER BY id DESC LIMIT ?`
    )
    .all(pid, lim);
}

/** Ensure every active branch has ACC/STONE products with base_unit set (no-op if already). */
export function ensureBaseUnitsForBranches(db) {
  const branches = listBranches(db).filter((b) => b.active !== false);
  void branches;
  try {
    db.prepare(
      `UPDATE products SET base_unit = unit
       WHERE (base_unit IS NULL OR TRIM(base_unit) = '')
         AND (product_id LIKE 'ACC-%' OR product_id LIKE 'STONE-%')`
    ).run();
  } catch {
    /* ignore */
  }
}
