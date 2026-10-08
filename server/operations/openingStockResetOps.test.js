import { describe, expect, it } from 'vitest';
import {
  ACCESSORY_ALREADY_RESET_PRODUCT_IDS,
  ACCESSORY_PHYSICAL_COUNTS,
  FLATSHEET_PHYSICAL_COUNTS,
  STONE_METRE_COUNTED_0P20,
  previewOpeningStockReset,
} from './openingStockResetOps.js';

async function memDb() {
  let Database;
  try {
    Database = (await import('better-sqlite3')).default;
  } catch {
    return null;
  }
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE branches (id TEXT PRIMARY KEY, code TEXT, name TEXT, active INTEGER);
    INSERT INTO branches VALUES ('BR-KD','KD','Kaduna',1), ('BR-YL','YL','Yola',1);
    CREATE TABLE products (
      product_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      name TEXT,
      unit TEXT,
      stock_level REAL,
      PRIMARY KEY (branch_id, product_id)
    );
    CREATE TABLE opening_stock_reset_runs (
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
  for (const a of ACCESSORY_PHYSICAL_COUNTS) {
    db.prepare(
      `INSERT INTO products (product_id, branch_id, name, unit, stock_level) VALUES (?,?,?,?,?)`
    ).run(a.productId, 'BR-KD', a.productId, 'pack', 0);
  }
  for (const a of ACCESSORY_ALREADY_RESET_PRODUCT_IDS) {
    db.prepare(
      `INSERT INTO products (product_id, branch_id, name, unit, stock_level) VALUES (?,?,?,?,?)`
    ).run(a, 'BR-KD', a, 'pack', 100);
  }
  for (const f of FLATSHEET_PHYSICAL_COUNTS) {
    db.prepare(
      `INSERT INTO products (product_id, branch_id, name, unit, stock_level) VALUES (?,?,?,'sheet',?)`
    ).run(f.productId, 'BR-KD', f.productId, 99);
  }
  db.prepare(
    `INSERT INTO products (product_id, branch_id, name, unit, stock_level) VALUES (?,?,?,'sheet',?)`
  ).run('STONE-FS-other-2m', 'BR-KD', 'Other FS', 12);
  for (const s of STONE_METRE_COUNTED_0P20) {
    db.prepare(
      `INSERT INTO products (product_id, branch_id, name, unit, stock_level) VALUES (?,?,?,'m',?)`
    ).run(s.productId, 'BR-KD', s.productId, 1);
  }
  db.prepare(
    `INSERT INTO products (product_id, branch_id, name, unit, stock_level) VALUES (?,?,?,'m',?)`
  ).run('STONE-milano-black-0.18mm', 'BR-KD', 'Milano black 0.18', 99);
  db.prepare(
    `INSERT INTO products (product_id, branch_id, name, unit, stock_level) VALUES (?,?,?,'m',?)`
  ).run('STONE-single-black-0.20mm', 'BR-KD', 'Single black', 40);
  return db;
}

describe('openingStockResetOps KD preview (revised)', () => {
  it('rejects non-KD branches', async () => {
    const db = await memDb();
    if (!db) return;
    const prev = previewOpeningStockReset(db, 'BR-YL');
    expect(prev.ok).toBe(false);
    db.close();
  });

  it('excludes already-reset accessories; posts silicone/stone nail; zeros other metres/FS', async () => {
    const db = await memDb();
    if (!db) return;
    const prev = previewOpeningStockReset(db, 'BR-KD');
    expect(prev.ok).toBe(true);
    expect(prev.excludedAccessories).toHaveLength(6);
    expect(prev.lines.some((l) => l.productId === 'ACC-TAPPING-SCREW-PCS')).toBe(false);
    const sil = prev.lines.find((l) => l.productId === 'ACC-SILICON-TUBE');
    expect(sil?.target).toBe(20);
    expect(sil?.unitCostNgn).toBe(1800);
    expect(sil?.reason).toMatch(/8 Oct/);
    const nail = prev.lines.find((l) => l.productId === 'ACC-STONE-NAIL-PACK');
    expect(nail?.target).toBe(20);
    expect(nail?.unitCostNgn).toBe(9000);
    const black2 = prev.lines.find((l) => l.productId === 'STONE-FS-black-2m');
    expect(black2?.target).toBe(113);
    const otherFs = prev.lines.find((l) => l.productId === 'STONE-FS-other-2m');
    expect(otherFs?.target).toBe(0);
    const milano20 = prev.lines.find((l) => l.productId === 'STONE-milano-black-0.20mm');
    expect(milano20?.target).toBe(750);
    expect(milano20?.unitCostNgn).toBe(4400);
    const milano18 = prev.lines.find((l) => l.productId === 'STONE-milano-black-0.18mm');
    expect(milano18?.target).toBe(0);
    expect(milano18?.role).toBe('zero_other_metre');
    const single = prev.lines.find((l) => l.productId === 'STONE-single-black-0.20mm');
    expect(single?.target).toBe(0);
    expect(prev.zeroOtherMetre.some((z) => z.productId === 'STONE-single-black-0.20mm')).toBe(true);
    expect(prev.ambiguousCount).toBe(0);
    db.close();
  });
});
