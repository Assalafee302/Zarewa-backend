import { describe, expect, it } from 'vitest';
import { createDatabase } from './db.js';
import { listPurchaseOrders, listQuotations, listStockMovements } from './readModel.js';
import { buildDashboardBootstrap, buildShellBootstrap } from './bootstrap.js';
import { insertCustomer, insertSupplier } from './writeOps.js';

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

describe.skipIf(!mysqlOk)('readModel list performance helpers', () => {
  it('listPurchaseOrders batch-loads lines for multiple POs', () => {
    const db = createDatabase(':memory:', { seed: false });
    insertSupplier(db, { supplierID: 'S1', name: 'Supplier 1' });
    insertSupplier(db, { supplierID: 'S2', name: 'Supplier 2' });
    db.exec(`
      INSERT INTO purchase_orders (po_id, supplier_id, supplier_name, order_date_iso, status, branch_id)
      VALUES ('PO-1', 'S1', 'Supplier 1', '2026-07-01', 'Approved', 'BR-KD'),
             ('PO-2', 'S2', 'Supplier 2', '2026-07-02', 'Approved', 'BR-KD');
      INSERT INTO purchase_order_lines (po_id, line_key, product_id, product_name, qty_ordered, qty_received)
      VALUES ('PO-1', 'L1', 'P1', 'Product 1', 10, 0),
             ('PO-2', 'L1', 'P2', 'Product 2', 5, 0),
             ('PO-2', 'L2', 'P3', 'Product 3', 3, 0);
    `);
    const pos = listPurchaseOrders(db, 'BR-KD');
    expect(pos).toHaveLength(2);
    expect(pos.find((p) => p.poID === 'PO-1')?.lines).toHaveLength(1);
    expect(pos.find((p) => p.poID === 'PO-2')?.lines).toHaveLength(2);
    db.close();
  });

  it('listQuotations respects SQL limit', () => {
    const db = createDatabase(':memory:', { seed: false });
    insertCustomer(db, { customerID: 'C1', name: 'Customer' }, 'BR-KD');
    for (let i = 1; i <= 5; i += 1) {
      db.prepare(
        `INSERT INTO quotations (id, customer_id, customer, date_iso, status, branch_id, total_ngn)
         VALUES (?, 'C1', 'Customer', ?, 'Open', 'BR-KD', 1000)`
      ).run(`Q-${i}`, `2026-07-0${i}`);
    }
    const limited = listQuotations(db, 'BR-KD', { limit: 2 });
    expect(limited).toHaveLength(2);
    expect(limited[0].id).toBe('Q-5');
    db.close();
  });

  it('listStockMovements respects SQL limit', () => {
    const db = createDatabase(':memory:', { seed: false });
    for (let i = 1; i <= 4; i += 1) {
      db.prepare(
        `INSERT INTO stock_movements (id, type, product_id, qty, at_iso, date_iso, branch_id)
         VALUES (?, 'ADJUSTMENT', 'P1', 1, ?, ?, 'BR-KD')`
      ).run(`M-${i}`, `2026-07-0${i}T12:00:00Z`, `2026-07-0${i}`);
    }
    const limited = listStockMovements(db, 'BR-KD', { limit: 2 });
    expect(limited).toHaveLength(2);
    db.close();
  });

  it('buildDashboardBootstrap skips side effects and applies list limits', () => {
    const db = createDatabase(':memory:', { seed: false });
    for (let i = 1; i <= 5; i += 1) {
      db.prepare(
        `INSERT INTO stock_movements (id, type, product_id, qty, at_iso, date_iso, branch_id)
         VALUES (?, 'ADJUSTMENT', 'P1', 1, ?, ?, 'BR-KD')`
      ).run(`M-${i}`, `2026-07-0${i}T12:00:00Z`, `2026-07-0${i}`);
    }
    const snap = buildDashboardBootstrap(db, {
      user: { id: 1, roleKey: 'md', displayName: 'MD' },
      session: { authenticated: true, user: { id: 1, roleKey: 'md' }, permissions: ['dashboard.view'] },
      branchScope: 'BR-KD',
      limit: 2,
    });
    expect(snap.ok).toBe(true);
    expect(snap.movements.length).toBeLessThanOrEqual(2);
    expect(snap.customers).toEqual([]);
    expect(snap.expenses).toEqual([]);
    expect(snap.coilLots).toEqual([]);
    expect(snap.productionJobCoils).toEqual([]);
    expect(snap.bootstrapMeta?.deferredDeskArrays).toEqual(
      expect.arrayContaining(['customers', 'expenses', 'coilLots', 'productionJobCoils'])
    );
    db.close();
  });

  it('buildShellBootstrap stays lean and defers desk registers', () => {
    const db = createDatabase(':memory:', { seed: false });
    for (let i = 1; i <= 5; i += 1) {
      db.prepare(
        `INSERT INTO stock_movements (id, type, product_id, qty, at_iso, date_iso, branch_id)
         VALUES (?, 'ADJUSTMENT', 'P1', 1, ?, ?, 'BR-KD')`
      ).run(`M-${i}`, `2026-07-0${i}T12:00:00Z`, `2026-07-0${i}`);
    }
    const snap = buildShellBootstrap(db, {
      user: { id: 1, roleKey: 'md', displayName: 'MD' },
      session: { authenticated: true, user: { id: 1, roleKey: 'md' }, permissions: ['dashboard.view'] },
      branchScope: 'BR-KD',
    });
    expect(snap.ok).toBe(true);
    expect(snap.bootstrapMeta?.mode).toBe('shell');
    expect(snap.workspaceBranches.length).toBeGreaterThan(0);
    expect(snap.customers).toEqual([]);
    expect(snap.quotations).toEqual([]);
    expect(snap.receipts).toEqual([]);
    expect(snap.productionJobs).toEqual([]);
    expect(snap.purchaseOrders).toEqual([]);
    expect(snap.movements).toEqual([]);
    expect(snap.bootstrapMeta?.deferredDeskArrays).toEqual(
      expect.arrayContaining(['quotations', 'receipts', 'productionJobs', 'customers'])
    );
    db.close();
  });
});
