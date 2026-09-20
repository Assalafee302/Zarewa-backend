import { describe, expect, it } from 'vitest';
import {
  insertStockMovementTx,
  migrateStockMovementsBranchId,
  resolveStockMovementBranchId,
} from './stockMovementOps.js';

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
    CREATE TABLE production_jobs (job_id TEXT PRIMARY KEY, branch_id TEXT NOT NULL);
    CREATE TABLE products (product_id TEXT NOT NULL, branch_id TEXT NOT NULL DEFAULT '', stock_level REAL, PRIMARY KEY (branch_id, product_id));
    CREATE TABLE stock_movements (
      id TEXT PRIMARY KEY, at_iso TEXT NOT NULL, type TEXT NOT NULL, ref TEXT, product_id TEXT,
      qty REAL, detail TEXT, date_iso TEXT, unit_price_ngn INTEGER, value_ngn INTEGER, branch_id TEXT NOT NULL DEFAULT ''
    );
    INSERT INTO production_jobs (job_id, branch_id) VALUES ('JOB-1','BR-YL');
    INSERT INTO products (product_id, branch_id, stock_level) VALUES ('ACC-RIVET-PACK','BR-YL',10);
  `);
  return db;
}

describe('stockMovementOps', () => {
  it('resolves branch from production job ref', async () => {
    const db = await tryMemDb();
    if (!db) return;
    expect(resolveStockMovementBranchId(db, { ref: 'JOB-1' })).toBe('BR-YL');
    db.close();
  });

  it('resolves branch from branch-scoped product when ref is generic', async () => {
    const db = await tryMemDb();
    if (!db) return;
    expect(resolveStockMovementBranchId(db, { ref: 'DIRECT', productID: 'ACC-RIVET-PACK' })).toBe('BR-YL');
    db.close();
  });

  it('inserts branch_id on movements', async () => {
    const db = await tryMemDb();
    if (!db) return;
    migrateStockMovementsBranchId(db);
    insertStockMovementTx(db, {
      id: 'MV-1',
      type: 'ACCESSORY_ISSUE',
      ref: 'JOB-1',
      productID: 'ACC-RIVET-PACK',
      qty: -2,
    });
    const row = db.prepare(`SELECT branch_id FROM stock_movements WHERE id = 'MV-1'`).get();
    expect(row?.branch_id).toBe('BR-YL');
    db.close();
  });

  it('does not invent Kaduna when the accessory SKU exists on multiple branches', async () => {
    const db = await tryMemDb();
    if (!db) return;
    db.prepare(
      `INSERT INTO products (product_id, branch_id, stock_level) VALUES ('ACC-RIVET-PACK','BR-KD',40)`
    ).run();
    expect(
      resolveStockMovementBranchId(db, { ref: 'DIRECT', productID: 'ACC-RIVET-PACK', type: 'STORE_ACCESSORY_DIRECT' })
    ).toBeNull();
    expect(() =>
      insertStockMovementTx(db, {
        id: 'MV-2',
        type: 'STORE_ACCESSORY_DIRECT',
        ref: 'DIRECT',
        productID: 'ACC-RIVET-PACK',
        qty: 12,
      })
    ).toThrow(/branch_id is required/i);
    insertStockMovementTx(db, {
      id: 'MV-3',
      type: 'STORE_ACCESSORY_DIRECT',
      ref: 'DIRECT',
      productID: 'ACC-RIVET-PACK',
      qty: 12,
      branchId: 'BR-YL',
    });
    expect(db.prepare(`SELECT branch_id FROM stock_movements WHERE id = 'MV-3'`).get()?.branch_id).toBe('BR-YL');
    db.close();
  });
});
