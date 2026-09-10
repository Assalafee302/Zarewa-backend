import { describe, expect, it } from 'vitest';
import { createDatabase } from './db.js';
import {
  listCuttingLists,
  listPurchaseOrders,
  listQuotations,
  listRefunds,
  listStockMovements,
  countQuotations,
  countStockMovements,
} from './readModel.js';
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

    const page2 = listQuotations(db, 'BR-KD', { limit: 2, offset: 2 });
    expect(page2).toHaveLength(2);
    expect(page2[0].id).toBe('Q-3');
    expect(page2.map((q) => q.id)).not.toEqual(limited.map((q) => q.id));

    expect(countQuotations(db, 'BR-KD')).toBe(5);
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

  it('buildDashboardBootstrap is shell-first and defers desk registers', () => {
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
    expect(snap.bootstrapMeta?.mode).toBe('dashboard');
    expect(snap.movements).toEqual([]);
    expect(snap.customers).toEqual([]);
    expect(snap.expenses).toEqual([]);
    expect(snap.coilLots).toEqual([]);
    expect(snap.productionJobCoils).toEqual([]);
    expect(snap.bootstrapMeta?.deferredDeskArrays).toEqual(
      expect.arrayContaining(['customers', 'expenses', 'coilLots', 'productionJobCoils', 'quotations'])
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
    expect(snap.masterData).toEqual(
      expect.objectContaining({
        gauges: expect.any(Array),
        materialTypes: expect.any(Array),
      })
    );
    expect(snap.bootstrapMeta?.deferredDeskArrays).toEqual(
      expect.arrayContaining(['quotations', 'receipts', 'productionJobs', 'customers'])
    );
    expect(snap.bootstrapMeta?.deferredDeskArrays).not.toContain('masterData');
    db.close();
  });

  it('listCuttingLists batch-loads lines without per-row queries', () => {
    const db = createDatabase(':memory:', { seed: false });
    insertCustomer(db, { customerID: 'C1', name: 'Customer' }, 'BR-KD');
    db.exec(`
      INSERT INTO cutting_lists (id, customer_id, customer_name, quotation_ref, date_iso, date_label, status, branch_id, sheets_to_cut, total_meters)
      VALUES ('CL-1', 'C1', 'Customer', 'Q-1', '2026-07-02', '2 Jul', 'Open', 'BR-KD', 2, 10),
             ('CL-2', 'C1', 'Customer', 'Q-2', '2026-07-01', '1 Jul', 'Open', 'BR-KD', 1, 5);
      INSERT INTO cutting_list_lines (cutting_list_id, sort_order, sheets, length_m, total_m, line_type)
      VALUES ('CL-1', 1, 2, 5, 10, 'Roof'),
             ('CL-2', 1, 1, 5, 5, 'Roof'),
             ('CL-2', 2, 1, 3, 3, 'Cladding');
    `);
    const lists = listCuttingLists(db, 'BR-KD');
    expect(lists).toHaveLength(2);
    expect(lists.find((c) => c.id === 'CL-1')?.lines).toHaveLength(1);
    expect(lists.find((c) => c.id === 'CL-2')?.lines).toHaveLength(2);
    db.close();
  });

  it('listQuotations can omit fat line payloads for desk lists', () => {
    const db = createDatabase(':memory:', { seed: false });
    insertCustomer(db, { customerID: 'C1', name: 'Customer' }, 'BR-KD');
    const lines = JSON.stringify({
      materialGauge: '0.5',
      materialColor: 'Blue',
      products: [{ name: 'Roof', qty: '10', unitPrice: '1000' }],
    });
    db.prepare(
      `INSERT INTO quotations (id, customer_id, customer, date_iso, status, branch_id, total_ngn, lines_json)
       VALUES ('Q-SLIM', 'C1', 'Customer', '2026-07-01', 'Open', 'BR-KD', 10000, ?)`
    ).run(lines);
    const slim = listQuotations(db, 'BR-KD', { includeLines: false });
    expect(slim).toHaveLength(1);
    expect(slim[0].quotationLines).toBeUndefined();
    expect(slim[0].materialGauge).toBe('0.5');
    const full = listQuotations(db, 'BR-KD', { includeLines: true });
    expect(full[0].quotationLines?.products?.length).toBe(1);
    db.close();
  });

  it('listRefunds omits previewSnapshot unless opted in', () => {
    const db = createDatabase(':memory:', { seed: false });
    insertCustomer(db, { customerID: 'C1', name: 'Customer' }, 'BR-KD');
    const fat = JSON.stringify({ lines: [{ a: 1 }], meta: 'x'.repeat(2000) });
    db.prepare(
      `INSERT INTO customer_refunds (
         refund_id, customer_id, customer_name, amount_ngn, status, requested_at_iso, branch_id,
         preview_snapshot_json, calculation_lines_json
       ) VALUES ('RF-SLIM', 'C1', 'Customer', 5000, 'Pending', '2026-07-01T00:00:00.000Z', 'BR-KD', ?, '[]')`
    ).run(fat);
    const slim = listRefunds(db, 'BR-KD');
    expect(slim).toHaveLength(1);
    expect(slim[0].previewSnapshot).toBeNull();
    const full = listRefunds(db, 'BR-KD', { includePreviewSnapshot: true });
    expect(full[0].previewSnapshot?.meta).toBeTruthy();
    db.close();
  });

  it('listStockMovements supports SQL offset', () => {
    const db = createDatabase(':memory:', { seed: false });
    for (let i = 1; i <= 4; i += 1) {
      db.prepare(
        `INSERT INTO stock_movements (id, type, product_id, qty, at_iso, date_iso, branch_id)
         VALUES (?, 'ADJUSTMENT', 'P1', 1, ?, ?, 'BR-KD')`
      ).run(`M-${i}`, `2026-07-0${i}T12:00:00Z`, `2026-07-0${i}`);
    }
    expect(listStockMovements(db, 'BR-KD', { limit: 2, offset: 2 })).toHaveLength(2);
    expect(countStockMovements(db, 'BR-KD')).toBe(4);
    db.close();
  });
});
