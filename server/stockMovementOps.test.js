import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import {
  insertStockMovementTx,
  migrateStockMovementsBranchId,
  resolveStockMovementBranchId,
} from './stockMovementOps.js';

function memDb() {
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
  it('resolves branch from production job ref', () => {
    const db = memDb();
    expect(resolveStockMovementBranchId(db, { ref: 'JOB-1' })).toBe('BR-YL');
  });

  it('resolves branch from branch-scoped product when ref is generic', () => {
    const db = memDb();
    expect(resolveStockMovementBranchId(db, { ref: 'DIRECT', productID: 'ACC-RIVET-PACK' })).toBe('BR-YL');
  });

  it('inserts branch_id on movements', () => {
    const db = memDb();
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
  });
});
