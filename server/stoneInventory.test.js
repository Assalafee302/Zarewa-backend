import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import {
  ensureStoneFlatsheetProduct,
  ensureStoneProduct,
  isStoneMeterQuotationLinesJson,
  stoneFlatsheetProductIdFromSpec,
  stoneProductIdFromSpec,
} from './stoneInventory.js';

describe('stoneInventory', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
  });

  afterEach(() => {
    db?.close();
  });

  it('stoneProductIdFromSpec builds stable id', () => {
    expect(stoneProductIdFromSpec('Milano', 'Black', '0.40mm')).toBe('STONE-milano-black-0.40mm');
  });

  it('ensureStoneProduct inserts metre SKU', () => {
    const pid = ensureStoneProduct(db, { designLabel: 'Bond', colourLabel: 'Red', gaugeLabel: '0.50mm' });
    expect(pid).toBe('STONE-bond-red-0.50mm');
    const row = db.prepare(`SELECT unit, material_type FROM products WHERE product_id = ?`).get(pid);
    expect(row.unit).toBe('m');
    expect(String(row.material_type)).toContain('Stone');
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

  it('stoneFlatsheetProductIdFromSpec builds stable id', () => {
    expect(stoneFlatsheetProductIdFromSpec('Black', 1.4)).toBe('STONE-FS-black-1p4m');
    expect(stoneFlatsheetProductIdFromSpec('Black', 1.5)).toBe('STONE-FS-black-1p5m');
    expect(stoneFlatsheetProductIdFromSpec('Ivory Beige', 2)).toBe('STONE-FS-ivory-beige-2m');
  });

  it('ensureStoneFlatsheetProduct inserts m² SKU', () => {
    const pid = ensureStoneFlatsheetProduct(db, { colourLabel: 'Red', lengthM: 1.4 });
    expect(pid).toBe('STONE-FS-red-1p4m');
    const row = db.prepare(`SELECT unit, gauge FROM products WHERE product_id = ?`).get(pid);
    expect(row.unit).toBe('m2');
    expect(String(row.gauge || '').trim()).toBe('');
  });
});
