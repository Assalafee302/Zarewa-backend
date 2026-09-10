import { describe, expect, it } from 'vitest';
import {
  adjustProductStockForBranch,
  ensureNonCoilProductRowsForAllBranches,
  getProductRowForWorkspace,
  migrateProductsBranchCompositeInventory,
  productsTableHasBranchCompositePk,
} from './productBranchInventory.js';

/** Minimal better-sqlite3-compatible harness (package may be absent in MySQL-only installs). */
async function tryMemDb() {
  let Database;
  try {
    Database = (await import('better-sqlite3')).default;
  } catch {
    return null;
  }
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE branches (id TEXT PRIMARY KEY, code TEXT, name TEXT, active INTEGER, sort_order INTEGER);
    INSERT INTO branches (id, code, name, active, sort_order) VALUES
      ('BR-KD','KD','Kaduna',1,1),
      ('BR-YL','YL','Yola',1,2),
      ('BR-MDG','MDG','Maiduguri',1,3);
    CREATE TABLE products (
      product_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      stock_level REAL NOT NULL DEFAULT 0,
      unit TEXT NOT NULL,
      low_stock_threshold REAL NOT NULL DEFAULT 0,
      reorder_qty REAL NOT NULL DEFAULT 0,
      gauge TEXT, colour TEXT, material_type TEXT,
      dashboard_attrs_json TEXT,
      branch_id TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE wip_balances (branch_id TEXT NOT NULL DEFAULT '', product_id TEXT NOT NULL, qty REAL NOT NULL DEFAULT 0, PRIMARY KEY (branch_id, product_id));
  `);
  return db;
}

describe('productBranchInventory', () => {
  it('expands accessories per branch and keeps coils global', async () => {
    const db = await tryMemDb();
    if (!db) return;
    db.prepare(
      `INSERT INTO products (product_id, name, stock_level, unit, low_stock_threshold, reorder_qty, dashboard_attrs_json, branch_id)
       VALUES ('ACC-RIVET-PACK','Rivets',50,'pack',0,0,'{"inventoryModel":"consumable"}','')`
    ).run();
    db.prepare(
      `INSERT INTO products (product_id, name, stock_level, unit, low_stock_threshold, reorder_qty, dashboard_attrs_json, branch_id)
       VALUES ('COIL-ALU','Coil',1000,'kg',0,0,'{"inventoryModel":"coil_kg"}','BR-KD')`
    ).run();

    migrateProductsBranchCompositeInventory(db);
    expect(productsTableHasBranchCompositePk(db)).toBe(true);

    const kd = getProductRowForWorkspace(db, 'ACC-RIVET-PACK', 'BR-KD');
    const yl = getProductRowForWorkspace(db, 'ACC-RIVET-PACK', 'BR-YL');
    expect(kd?.stock_level).toBe(50);
    expect(yl?.stock_level).toBe(0);

    const coil = getProductRowForWorkspace(db, 'COIL-ALU', 'BR-YL');
    expect(coil?.stock_level).toBe(1000);
    db.close();
  });

  it('adjustProductStockForBranch updates only the target branch row', async () => {
    const db = await tryMemDb();
    if (!db) return;
    db.exec(`DROP TABLE products`);
    db.exec(`
      CREATE TABLE products (
        product_id TEXT NOT NULL,
        name TEXT NOT NULL,
        stock_level REAL NOT NULL DEFAULT 0,
        unit TEXT NOT NULL,
        low_stock_threshold REAL NOT NULL DEFAULT 0,
        reorder_qty REAL NOT NULL DEFAULT 0,
        gauge TEXT, colour TEXT, material_type TEXT,
        dashboard_attrs_json TEXT,
        branch_id TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (branch_id, product_id)
      );
    `);
    db.prepare(
      `INSERT INTO products (product_id, name, stock_level, unit, low_stock_threshold, reorder_qty, dashboard_attrs_json, branch_id)
       VALUES ('ACC-RIVET-PACK','Rivets',10,'pack',0,0,'{"inventoryModel":"consumable"}','BR-KD')`
    ).run();
    db.prepare(
      `INSERT INTO products (product_id, name, stock_level, unit, low_stock_threshold, reorder_qty, dashboard_attrs_json, branch_id)
       VALUES ('ACC-RIVET-PACK','Rivets',20,'pack',0,0,'{"inventoryModel":"consumable"}','BR-YL')`
    ).run();

    adjustProductStockForBranch(db, 'ACC-RIVET-PACK', -3, 'BR-KD');

    expect(getProductRowForWorkspace(db, 'ACC-RIVET-PACK', 'BR-KD')?.stock_level).toBe(7);
    expect(getProductRowForWorkspace(db, 'ACC-RIVET-PACK', 'BR-YL')?.stock_level).toBe(20);
    db.close();
  });

  it('ensureNonCoilProductRowsForAllBranches copies BR-KD-only accessories/stone onto Yola at 0', async () => {
    const db = await tryMemDb();
    if (!db) return;
    db.exec(`DROP TABLE products`);
    db.exec(`
      CREATE TABLE products (
        product_id TEXT NOT NULL,
        name TEXT NOT NULL,
        stock_level REAL NOT NULL DEFAULT 0,
        unit TEXT NOT NULL,
        low_stock_threshold REAL NOT NULL DEFAULT 0,
        reorder_qty REAL NOT NULL DEFAULT 0,
        gauge TEXT, colour TEXT, material_type TEXT,
        dashboard_attrs_json TEXT,
        branch_id TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (branch_id, product_id)
      );
    `);
    db.prepare(
      `INSERT INTO products (product_id, name, stock_level, unit, low_stock_threshold, reorder_qty, dashboard_attrs_json, branch_id)
       VALUES ('ACC-RIVET-PACK','Rivets',50,'pack',0,0,'{"inventoryModel":"consumable"}','BR-KD')`
    ).run();
    db.prepare(
      `INSERT INTO products (product_id, name, stock_level, unit, low_stock_threshold, reorder_qty, dashboard_attrs_json, branch_id)
       VALUES ('STONE-bond-red-0.50mm','Stone coated Bond / Red / 0.50mm',120,'m',0,0,'{"inventoryModel":"stone_meter"}','BR-KD')`
    ).run();

    ensureNonCoilProductRowsForAllBranches(db);

    expect(getProductRowForWorkspace(db, 'ACC-RIVET-PACK', 'BR-YL')?.stock_level).toBe(0);
    expect(getProductRowForWorkspace(db, 'ACC-RIVET-PACK', 'BR-KD')?.stock_level).toBe(50);
    expect(getProductRowForWorkspace(db, 'STONE-bond-red-0.50mm', 'BR-YL')?.stock_level).toBe(0);
    expect(getProductRowForWorkspace(db, 'STONE-bond-red-0.50mm', 'BR-KD')?.stock_level).toBe(120);
    expect(getProductRowForWorkspace(db, 'ACC-RIVET-PACK', '')).toBeNull();
    db.close();
  });
});
