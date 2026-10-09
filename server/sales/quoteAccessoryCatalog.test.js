import { afterEach, describe, expect, it } from 'vitest';
import {
  assertQuoteAccessoriesFromMaster,
  freeTextAccessoriesBlocked,
  isClientQuoteLineId,
} from './quoteAccessoryCatalog.js';

async function memDb() {
  let Database;
  try {
    Database = (await import('better-sqlite3')).default;
  } catch {
    return null;
  }
  const db = new Database(':memory:');
  db.exec(`
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
    INSERT INTO setup_quote_items
      (item_id, item_type, name, unit, floor_unit_price_ngn, active, inventory_product_id)
    VALUES
      ('SQI-012', 'accessory', 'Drive screw nail', 'pack', 100, 1, 'ACC-DRIVE-SCREW-PACK'),
      ('SQI-006', 'accessory', 'Silicone tube', 'pcs', 50, 1, 'ACC-SILICON-TUBE'),
      ('SQI-X', 'accessory', 'Unlinked accessory', 'pcs', 0, 1, NULL),
      ('SQI-OFF', 'accessory', 'Retired nail', 'pack', 0, 0, 'ACC-RETIRED');
  `);
  return db;
}

describe('quoteAccessoryCatalog', () => {
  const prev = process.env.ZAREWA_BLOCK_FREE_TEXT_ACCESSORIES;

  afterEach(() => {
    if (prev == null) delete process.env.ZAREWA_BLOCK_FREE_TEXT_ACCESSORIES;
    else process.env.ZAREWA_BLOCK_FREE_TEXT_ACCESSORIES = prev;
  });

  it('detects client L- line ids', () => {
    expect(isClientQuoteLineId('L1791550302568-zhl8a8e')).toBe(true);
    expect(isClientQuoteLineId('SQI-012')).toBe(false);
  });

  it('accepts named lines that only carry a client L- id', async () => {
    const db = await memDb();
    if (!db) return;
    process.env.ZAREWA_BLOCK_FREE_TEXT_ACCESSORIES = '1';
    const gate = assertQuoteAccessoriesFromMaster(db, [
      { id: 'L1791550302568-zhl8a8e', name: 'Drive screw nail', qty: 2, unitPrice: 200 },
    ]);
    expect(gate.ok).toBe(true);
    expect(gate.lines[0].setupQuoteItemId).toBe('SQI-012');
    expect(gate.lines[0].inventoryProductId).toBe('ACC-DRIVE-SCREW-PACK');
    db.close();
  });

  it('skips empty draft L- rows so save is not blocked', async () => {
    const db = await memDb();
    if (!db) return;
    process.env.ZAREWA_BLOCK_FREE_TEXT_ACCESSORIES = '1';
    const gate = assertQuoteAccessoriesFromMaster(db, [
      { id: 'L1791550302568-zhl8a8e' },
      { id: 'L1791550302999-abc', name: 'Silicone tube', qty: 1, unitPrice: 80 },
    ]);
    expect(gate.ok).toBe(true);
    expect(gate.lines).toHaveLength(1);
    expect(gate.lines[0].setupQuoteItemId).toBe('SQI-006');
    db.close();
  });

  it('matches setupQuoteItemId and productName aliases', async () => {
    const db = await memDb();
    if (!db) return;
    process.env.ZAREWA_BLOCK_FREE_TEXT_ACCESSORIES = '1';
    const bySetup = assertQuoteAccessoriesFromMaster(db, [
      { id: 'L1-a', setupQuoteItemId: 'SQI-012', qty: 1, unitPrice: 200 },
    ]);
    expect(bySetup.ok).toBe(true);
    const byProductName = assertQuoteAccessoriesFromMaster(db, [
      { id: 'L1-b', productName: 'Silicone tube', qty: 1, unitPrice: 80 },
    ]);
    expect(byProductName.ok).toBe(true);
    db.close();
  });

  it('rejects unknown names and unlinked stock', async () => {
    const db = await memDb();
    if (!db) return;
    process.env.ZAREWA_BLOCK_FREE_TEXT_ACCESSORIES = '1';
    const unknown = assertQuoteAccessoriesFromMaster(db, [
      { id: 'L1-c', name: 'Made up nail', qty: 1, unitPrice: 10 },
    ]);
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toMatch(/Made up nail/);
    const unlinked = assertQuoteAccessoriesFromMaster(db, [
      { id: 'L1-d', name: 'Unlinked accessory', qty: 1, unitPrice: 10 },
    ]);
    expect(unlinked.ok).toBe(false);
    expect(unlinked.error).toMatch(/no stock link/);
    db.close();
  });

  it('can disable enforcement via env', () => {
    process.env.ZAREWA_BLOCK_FREE_TEXT_ACCESSORIES = '0';
    expect(freeTextAccessoriesBlocked()).toBe(false);
  });
});
