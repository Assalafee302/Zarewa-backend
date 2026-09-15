import { describe, expect, it } from 'vitest';
import {
  deleteMasterDataRecord,
  ensureAccessoryQuoteItemBranchOverlays,
  listMasterData,
  migrateSetupQuoteItemBranch,
  upsertMasterDataRecord,
} from './masterData.js';
import { resolveAccessoryInventoryProductId } from './accessoryFulfillment.js';

/** Minimal better-sqlite3-compatible harness. */
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
    CREATE TABLE setup_quote_items (
      item_id TEXT PRIMARY KEY,
      item_type TEXT NOT NULL,
      name TEXT NOT NULL,
      unit TEXT NOT NULL DEFAULT 'unit',
      default_unit_price_ngn INTEGER NOT NULL DEFAULT 0,
      floor_unit_price_ngn INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      inventory_product_id TEXT
    );
    CREATE TABLE setup_colours (
      colour_id TEXT PRIMARY KEY, name TEXT NOT NULL, abbreviation TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE setup_gauges (
      gauge_id TEXT PRIMARY KEY, label TEXT NOT NULL, gauge_mm REAL NOT NULL,
      active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE setup_material_types (
      material_type_id TEXT PRIMARY KEY, name TEXT NOT NULL,
      density_kg_per_m3 REAL NOT NULL DEFAULT 0, width_m REAL NOT NULL DEFAULT 1.2,
      active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0,
      inventory_model TEXT NOT NULL DEFAULT 'coil_kg'
    );
    CREATE TABLE setup_profiles (
      profile_id TEXT PRIMARY KEY, name TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0,
      material_type_id TEXT
    );
    CREATE TABLE setup_price_lists (
      price_id TEXT PRIMARY KEY, quote_item_id TEXT, item_name TEXT NOT NULL,
      unit TEXT NOT NULL DEFAULT 'unit', unit_price_ngn INTEGER NOT NULL DEFAULT 0,
      gauge_id TEXT, colour_id TEXT, material_type_id TEXT, profile_id TEXT, notes TEXT,
      active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0,
      book_label TEXT, book_version TEXT, effective_from_iso TEXT
    );
    CREATE TABLE setup_expense_categories (
      category_id TEXT PRIMARY KEY, name TEXT NOT NULL, code TEXT,
      active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE quotations (
      id TEXT PRIMARY KEY,
      branch_id TEXT,
      date_iso TEXT,
      archived INTEGER DEFAULT 0,
      status TEXT,
      quotation_lifecycle_note TEXT,
      lines_json TEXT
    );
    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at_iso TEXT,
      actor_user_id TEXT,
      actor_name TEXT,
      action TEXT,
      entity_kind TEXT,
      entity_id TEXT,
      note TEXT,
      details_json TEXT
    );
  `);
  return db;
}

describe('accessory quote-item branch overlays', () => {
  it('migrate expands overlays for each active branch', async () => {
    const db = await tryMemDb();
    if (!db) return;

    db.prepare(
      `INSERT INTO setup_quote_items (
         item_id, item_type, name, unit, default_unit_price_ngn, floor_unit_price_ngn, active, sort_order, inventory_product_id
       ) VALUES ('SQI-005','accessory','Tapping Screw','pcs',100,80,1,101,'ACC-TAPPING-SCREW-PCS')`
    ).run();
    db.prepare(
      `INSERT INTO setup_quote_items (
         item_id, item_type, name, unit, default_unit_price_ngn, floor_unit_price_ngn, active, sort_order, inventory_product_id
       ) VALUES ('SQI-001','product','Roofing Sheet','m',0,0,1,1,NULL)`
    ).run();

    migrateSetupQuoteItemBranch(db);
    ensureAccessoryQuoteItemBranchOverlays(db);

    const overlays = db
      .prepare(`SELECT item_id, branch_id, default_unit_price_ngn FROM setup_quote_item_branch ORDER BY item_id, branch_id`)
      .all();
    expect(overlays).toHaveLength(3);
    expect(overlays.every((r) => r.item_id === 'SQI-005')).toBe(true);
    expect(overlays.map((r) => r.branch_id).sort()).toEqual(['BR-KD', 'BR-MDG', 'BR-YL']);
    expect(overlays.every((r) => r.default_unit_price_ngn === 100)).toBe(true);
    db.close();
  });

  it('upsert price on BR-YL does not change BR-KD overlay', async () => {
    const db = await tryMemDb();
    if (!db) return;

    db.prepare(
      `INSERT INTO setup_quote_items (
         item_id, item_type, name, unit, default_unit_price_ngn, floor_unit_price_ngn, active, sort_order, inventory_product_id
       ) VALUES ('SQI-005','accessory','Tapping Screw','pcs',100,80,1,101,'ACC-TAPPING-SCREW-PCS')`
    ).run();
    migrateSetupQuoteItemBranch(db);

    upsertMasterDataRecord(
      db,
      'quote-items',
      {
        id: 'SQI-005',
        itemType: 'accessory',
        name: 'Tapping Screw',
        unit: 'pcs',
        defaultUnitPriceNgn: 250,
        floorUnitPriceNgn: 200,
        active: true,
        sortOrder: 101,
        inventoryProductId: 'ACC-TAPPING-SCREW-PCS',
        branchId: 'BR-YL',
      },
      null
    );

    const yl = listMasterData(db, { branchId: 'BR-YL' }).quoteItems.find((q) => q.id === 'SQI-005');
    const kd = listMasterData(db, { branchId: 'BR-KD' }).quoteItems.find((q) => q.id === 'SQI-005');
    expect(yl?.defaultUnitPriceNgn).toBe(250);
    expect(yl?.floorUnitPriceNgn).toBe(200);
    expect(kd?.defaultUnitPriceNgn).toBe(100);
    expect(kd?.floorUnitPriceNgn).toBe(80);

    const base = db.prepare(`SELECT default_unit_price_ngn FROM setup_quote_items WHERE item_id = 'SQI-005'`).get();
    expect(base.default_unit_price_ngn).toBe(100);
    db.close();
  });

  it('listMasterData diverges after branch price change', async () => {
    const db = await tryMemDb();
    if (!db) return;

    db.prepare(
      `INSERT INTO setup_quote_items (
         item_id, item_type, name, unit, default_unit_price_ngn, floor_unit_price_ngn, active, sort_order, inventory_product_id
       ) VALUES ('SQI-006','accessory','Silicone tube','tube',50,40,1,102,'ACC-SILICON-TUBE')`
    ).run();
    migrateSetupQuoteItemBranch(db);

    upsertMasterDataRecord(
      db,
      'quote-items',
      {
        id: 'SQI-006',
        itemType: 'accessory',
        name: 'Silicone tube',
        unit: 'tube',
        defaultUnitPriceNgn: 75,
        floorUnitPriceNgn: 60,
        active: true,
        sortOrder: 102,
        inventoryProductId: 'ACC-SILICON-TUBE',
        branchId: 'BR-YL',
      },
      null
    );

    const yl = listMasterData(db, { branchId: 'BR-YL' }).quoteItems.find((q) => q.id === 'SQI-006');
    const kd = listMasterData(db, { branchId: 'BR-KD' }).quoteItems.find((q) => q.id === 'SQI-006');
    expect(yl?.defaultUnitPriceNgn).toBe(75);
    expect(kd?.defaultUnitPriceNgn).toBe(50);
    expect(yl?.branchId).toBe('BR-YL');
    expect(kd?.branchId).toBe('BR-KD');
    db.close();
  });

  it('inventory product id resolution still works after overlay migrate', async () => {
    const db = await tryMemDb();
    if (!db) return;

    db.prepare(
      `INSERT INTO setup_quote_items (
         item_id, item_type, name, unit, default_unit_price_ngn, floor_unit_price_ngn, active, sort_order, inventory_product_id
       ) VALUES ('SQI-005','accessory','Tapping Screw','pcs',100,80,1,101,'ACC-TAPPING-SCREW-PCS')`
    ).run();
    migrateSetupQuoteItemBranch(db);

    expect(resolveAccessoryInventoryProductId(db, 'SQI-005', '', 'BR-YL')).toBe('ACC-TAPPING-SCREW-PCS');
    expect(resolveAccessoryInventoryProductId(db, '', 'Tapping Screw', 'BR-KD')).toBe(
      'ACC-TAPPING-SCREW-PCS'
    );

    deleteMasterDataRecord(db, 'quote-items', 'SQI-005', null, { branchId: 'BR-YL' });
    const yl = listMasterData(db, { branchId: 'BR-YL' }).quoteItems.find((q) => q.id === 'SQI-005');
    const kd = listMasterData(db, { branchId: 'BR-KD' }).quoteItems.find((q) => q.id === 'SQI-005');
    expect(yl?.active).toBe(false);
    expect(kd?.active).toBe(true);
    db.close();
  });
});
