import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import {
  ensureStoneFlatsheetProduct,
  ensureStoneProduct,
  isStoneMeterQuotationLinesJson,
  stoneFlatsheetProductIdFromSpec,
  stoneProductIdFromSpec,
} from './stoneInventory.js';

function mysqlAvailable() {
  try {
    const db = createDatabase(':memory:', { seed: false });
    db.close();
    return true;
  } catch {
    return false;
  }
}

const mysqlOk = mysqlAvailable();

describe('stoneInventory ids (pure)', () => {
  it('stoneProductIdFromSpec builds stable id', () => {
    expect(stoneProductIdFromSpec('Milano', 'Black', '0.40mm')).toBe('STONE-milano-black-0.40mm');
  });

  it('stoneFlatsheetProductIdFromSpec builds stable id', () => {
    expect(stoneFlatsheetProductIdFromSpec('Black', 1.4)).toBe('STONE-FS-black-1p4m');
    // Non-1.4 lengths map to the 2 m SKU slug (1.5 is normalized upstream before calling this).
    expect(stoneFlatsheetProductIdFromSpec('Black', 2)).toBe('STONE-FS-black-2m');
    expect(stoneFlatsheetProductIdFromSpec('Ivory Beige', 2)).toBe('STONE-FS-ivory-beige-2m');
  });
});

describe.skipIf(!mysqlOk)('stoneInventory', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
  });

  afterEach(() => {
    db?.close();
  });

  it('ensureStoneProduct inserts metre SKU on the given branch and expands others at 0', () => {
    const pid = ensureStoneProduct(db, {
      designLabel: 'Bond',
      colourLabel: 'Red',
      gaugeLabel: '0.50mm',
      branchId: 'BR-YL',
    });
    expect(pid).toBe('STONE-bond-red-0.50mm');
    const row = db
      .prepare(`SELECT unit, material_type, branch_id FROM products WHERE product_id = ? AND branch_id = ?`)
      .get(pid, 'BR-YL');
    expect(row.unit).toBe('m');
    expect(String(row.material_type)).toContain('Stone');
    expect(row.branch_id).toBe('BR-YL');
    const kd = db
      .prepare(`SELECT stock_level FROM products WHERE product_id = ? AND branch_id = ?`)
      .get(pid, 'BR-KD');
    expect(kd).toBeTruthy();
    expect(Number(kd.stock_level)).toBe(0);
  });

  it('ensureStoneProduct requires explicit branchId', () => {
    expect(() =>
      ensureStoneProduct(db, { designLabel: 'Bond', colourLabel: 'Red', gaugeLabel: '0.50mm' })
    ).toThrow(/branchId/i);
  });

  it('isStoneMeterQuotationLinesJson detects MAT-005', () => {
    expect(isStoneMeterQuotationLinesJson(db, { materialTypeId: 'MAT-005' })).toBe(true);
    expect(isStoneMeterQuotationLinesJson(db, { materialTypeId: 'MAT-002' })).toBe(false);
  });

  it('isStoneMeterQuotationLinesJson accepts JSON string from quotations.lines_json', () => {
    expect(
      isStoneMeterQuotationLinesJson(
        db,
        JSON.stringify({ materialTypeId: 'MAT-005', products: [{ name: 'Stone flatsheet 2', qty: 4 }] })
      )
    ).toBe(true);
    expect(isStoneMeterQuotationLinesJson(db, JSON.stringify({ materialTypeId: 'MAT-002' }))).toBe(false);
    expect(isStoneMeterQuotationLinesJson(db, '{')).toBe(false);
  });

  it('ensureStoneFlatsheetProduct inserts m² SKU', () => {
    const pid = ensureStoneFlatsheetProduct(db, { colourLabel: 'Red', lengthM: 1.4, branchId: 'BR-YL' });
    expect(pid).toBe('STONE-FS-red-1p4m');
    const row = db
      .prepare(`SELECT unit, gauge, branch_id FROM products WHERE product_id = ? AND branch_id = ?`)
      .get(pid, 'BR-YL');
    expect(row.unit).toBe('m2');
    expect(String(row.gauge || '').trim()).toBe('');
    expect(row.branch_id).toBe('BR-YL');
  });
});
