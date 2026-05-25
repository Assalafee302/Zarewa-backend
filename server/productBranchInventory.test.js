import { describe, expect, it, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  getProductRowForWorkspace,
  migrateProductsBranchCompositeInventory,
  productsTableHasBranchCompositePk,
} from './productBranchInventory.js';

function memDb() {
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
  it('expands accessories per branch and keeps coils global', () => {
    const db = memDb();
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
  });
});
