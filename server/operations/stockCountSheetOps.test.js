import { afterEach, describe, expect, it } from 'vitest';
import {
  assertCountSheetBranchId,
  buildStockCountSheet,
  buildStockCountSheetWorkbook,
  countUnitForProduct,
  isTailStockHold,
  stockCountSheetFilename,
} from './stockCountSheetOps.js';
import { STONE_FLATSHEET_WIDTH_M } from '../../shared/lib/poLineTypes.js';

describe('stockCountSheetOps helpers', () => {
  it('detects tail holds', () => {
    expect(isTailStockHold('Tail – not prime stock')).toBe(true);
    expect(isTailStockHold('tail piece — not prime')).toBe(true);
    expect(isTailStockHold('')).toBe(false);
    expect(isTailStockHold('Hold for QC')).toBe(false);
  });

  it('asserts KD/YL/MDG only', () => {
    expect(assertCountSheetBranchId('BR-KD').ok).toBe(true);
    expect(assertCountSheetBranchId('ALL').ok).toBe(false);
    expect(assertCountSheetBranchId('BR-KAD').ok).toBe(false);
  });

  it('derives flatsheet count unit and ERP sheets', () => {
    expect(
      countUnitForProduct({
        product_id: 'STONE-FS-green-2m',
        name: 'Stone flatsheet green 2m',
        unit: 'm2',
      })
    ).toBe('sheet (2 m)');
    expect(
      countUnitForProduct({
        product_id: 'ACC-silicon',
        name: 'Silicone repair kit',
        unit: 'pcs',
      })
    ).toBe('tube');
  });
});

describe('buildStockCountSheet', () => {
  let db;

  afterEach(() => {
    db?.close();
    db = null;
  });

  async function memDb() {
    let Database;
    try {
      Database = (await import('better-sqlite3')).default;
    } catch {
      return null;
    }
    const d = new Database(':memory:');
    d.exec(`
      CREATE TABLE branches (id TEXT PRIMARY KEY, code TEXT, name TEXT, active INTEGER, sort_order INTEGER);
      INSERT INTO branches VALUES
        ('BR-KD','KD','Kaduna',1,1),
        ('BR-YL','YL','Yola',1,2),
        ('BR-MDG','MDG','Maiduguri',1,3);
      CREATE TABLE coil_lots (
        coil_no TEXT PRIMARY KEY,
        branch_id TEXT,
        colour TEXT,
        gauge_label TEXT,
        qty_remaining REAL,
        current_weight_kg REAL,
        current_status TEXT,
        stock_hold TEXT,
        location TEXT,
        material_type_name TEXT
      );
      CREATE TABLE products (
        product_id TEXT NOT NULL,
        branch_id TEXT NOT NULL,
        name TEXT,
        unit TEXT,
        stock_level REAL,
        colour TEXT,
        gauge TEXT,
        material_type TEXT,
        dashboard_attrs_json TEXT,
        PRIMARY KEY (branch_id, product_id)
      );
    `);
    return d;
  }

  it('excludes tails, zero-stock ACC, and other-branch rows; manager includes ERP', async () => {
    db = await memDb();
    if (!db) return;

    db.prepare(
      `INSERT INTO coil_lots (coil_no, branch_id, colour, gauge_label, qty_remaining, current_weight_kg, current_status, stock_hold, location, material_type_name)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run('CL-P1', 'BR-KD', 'Bush Green', '0.20mm', 900, 900, 'Available', '', 'Yard', 'Aluminium');
    db.prepare(
      `INSERT INTO coil_lots (coil_no, branch_id, colour, gauge_label, qty_remaining, current_weight_kg, current_status, stock_hold, location, material_type_name)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run('CL-TAIL', 'BR-KD', 'Red', '0.24mm', 40, 40, 'Available', 'Tail – not prime stock', 'Yard', 'Aluminium');
    db.prepare(
      `INSERT INTO coil_lots (coil_no, branch_id, colour, gauge_label, qty_remaining, current_weight_kg, current_status, stock_hold, location, material_type_name)
       VALUES (?,?,?,?,?,?,?,?,?,?)`
    ).run('CL-YL', 'BR-YL', 'Blue', '0.20mm', 500, 500, 'Available', '', 'Yard', 'Aluminium');

    db.prepare(
      `INSERT INTO products (product_id, branch_id, name, unit, stock_level, colour, gauge, material_type, dashboard_attrs_json)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run('ACC-ridge', 'BR-KD', 'Ridge cap carton', 'carton', 12, '', '', 'accessory', null);
    db.prepare(
      `INSERT INTO products (product_id, branch_id, name, unit, stock_level, colour, gauge, material_type, dashboard_attrs_json)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run('ACC-empty', 'BR-KD', 'Empty pack', 'pack', 0, '', '', 'accessory', null);
    db.prepare(
      `INSERT INTO products (product_id, branch_id, name, unit, stock_level, colour, gauge, material_type, dashboard_attrs_json)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(
      'STONE-FS-green-2m',
      'BR-KD',
      'Stone flatsheet green 2m',
      'm2',
      2.4,
      'Green',
      '',
      'stone',
      JSON.stringify({ stoneFlatsheetLengthM: 2 })
    );
    db.prepare(
      `INSERT INTO products (product_id, branch_id, name, unit, stock_level, colour, gauge, material_type, dashboard_attrs_json)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(
      'STONE-milano-black-0.20mm',
      'BR-KD',
      'Stone coated Milano / Black 0.20mm',
      'm',
      18.5,
      'Black',
      '0.20mm',
      'stone',
      null
    );

    const r = buildStockCountSheet(db, 'BR-KD');
    expect(r.ok, r.error).toBe(true);
    expect(r.pack.coils.map((c) => c.coilNo)).toEqual(['CL-P1']);
    expect(r.pack.coils[0].erpKg).toBe(900);
    expect(r.pack.accessoriesStone.map((a) => a.productId).sort()).toEqual([
      'ACC-ridge',
      'STONE-FS-green-2m',
      'STONE-milano-black-0.20mm',
    ]);
    expect(r.pack.accessoriesStone.find((a) => a.productId === 'ACC-empty')).toBeUndefined();

    const fs = r.pack.accessoriesStone.find((a) => a.productId === 'STONE-FS-green-2m');
    expect(fs.countUnit).toBe('sheet (2 m)');
    expect(fs.erpQty).toBe(Math.round((2.4 / (2 * STONE_FLATSHEET_WIDTH_M)) * 1000) / 1000);

    // Walk order: ACC → stone m → flatsheet
    expect(r.pack.accessoriesStone.map((a) => a.section)).toEqual(['Accessory', 'Stone', 'Flatsheet']);

    const mgrCoil = r.pack.managerRows.find((m) => m.section === 'Coil');
    expect(mgrCoil.erp).toBe(900);
    expect(r.pack.managerRows.some((m) => m.item === 'CL-TAIL')).toBe(false);

    const buf = buildStockCountSheetWorkbook(r.pack);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(100);
    expect(stockCountSheetFilename(r.pack)).toMatch(/^KD-stock-count-/);
  });
});
