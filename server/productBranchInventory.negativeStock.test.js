import { describe, expect, it, afterEach } from 'vitest';
import { adjustProductStockForBranch } from './productBranchInventory.js';
import {
  consumeNegativeStockApprovalTx,
  createNegativeStockApproval,
} from './operations/negativeStockApprovalOps.js';

async function memDb() {
  let Database;
  try {
    Database = (await import('better-sqlite3')).default;
  } catch {
    return null;
  }
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE products (
      product_id TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      name TEXT,
      unit TEXT,
      stock_level REAL,
      dashboard_attrs_json TEXT,
      PRIMARY KEY (branch_id, product_id)
    );
    CREATE TABLE opening_stock_reset_runs (
      id TEXT PRIMARY KEY, branch_id TEXT, preview_json TEXT, posted_at_iso TEXT,
      posted_by_user_id TEXT, posted_by_name TEXT, status TEXT, note TEXT
    );
    CREATE TABLE negative_stock_approvals (
      id TEXT PRIMARY KEY, branch_id TEXT, product_id TEXT, job_id TEXT, ref TEXT,
      qty_requested REAL, stock_before REAL, reason TEXT,
      approved_by_user_id TEXT, approved_by_name TEXT, approved_at_iso TEXT,
      consumed_at_iso TEXT, consumed_by_user_id TEXT, status TEXT
    );
  `);
  db.prepare(
    `INSERT INTO products (product_id, branch_id, name, unit, stock_level) VALUES ('ACC-RIVET-PACK','BR-KD','Rivets','pack',5)`
  ).run();
  return db;
}

describe('negative stock gate', () => {
  afterEach(() => {
    delete process.env.ZAREWA_GATE_ACC_STONE_NEGATIVE;
  });

  it('allows legacy overdraw before gate', async () => {
    const db = await memDb();
    if (!db) return;
    process.env.ZAREWA_GATE_ACC_STONE_NEGATIVE = '0';
    expect(adjustProductStockForBranch(db, 'ACC-RIVET-PACK', -10, 'BR-KD')).toBe(true);
    const row = db.prepare(`SELECT stock_level FROM products WHERE product_id='ACC-RIVET-PACK'`).get();
    expect(row.stock_level).toBe(-5);
    db.close();
  });

  it('blocks overdraw when gate on unless allowNegative', async () => {
    const db = await memDb();
    if (!db) return;
    process.env.ZAREWA_GATE_ACC_STONE_NEGATIVE = '1';
    expect(() => adjustProductStockForBranch(db, 'ACC-RIVET-PACK', -10, 'BR-KD')).toThrow(
      /Insufficient stock/
    );
    expect(adjustProductStockForBranch(db, 'ACC-RIVET-PACK', -10, 'BR-KD', { allowNegative: true })).toBe(
      true
    );
    db.close();
  });

  it('approval cannot be consumed by the approver as completer', async () => {
    const db = await memDb();
    if (!db) return;
    const om = { id: 'U-OM', roleKey: 'operations_manager', name: 'OM' };
    const created = createNegativeStockApproval(
      db,
      { branchId: 'BR-KD', productId: 'ACC-RIVET-PACK', qtyRequested: 20, reason: 'Counted empty carton overnight' },
      om
    );
    expect(created.ok).toBe(true);
    const self = consumeNegativeStockApprovalTx(db, {
      approvalId: created.id,
      productId: 'ACC-RIVET-PACK',
      branchId: 'BR-KD',
      actor: om,
      qty: 10,
    });
    expect(self.ok).toBe(false);
    const other = consumeNegativeStockApprovalTx(db, {
      approvalId: created.id,
      productId: 'ACC-RIVET-PACK',
      branchId: 'BR-KD',
      actor: { id: 'U-STORE', roleKey: 'storekeeper' },
      qty: 10,
    });
    expect(other.ok).toBe(true);
    db.close();
  });
});
