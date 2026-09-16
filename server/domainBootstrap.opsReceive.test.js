/**
 * Store GRN: operations snapshot must include Approved POs before transport link.
 * Prior lean ops hydrate only shipped inTransitLoads — MD-approved POs stayed invisible.
 */
import { describe, expect, it } from 'vitest';
import { createDatabase } from './db.js';
import { buildOperationsDomainSnapshot } from './domainBootstrap.js';
import { insertSupplier } from './writeOps.js';
import { listPurchaseOrders } from './readModel.js';
import { isMysqlAvailableForTests } from './testIntegrationHarness.js';

const mysqlOk = isMysqlAvailableForTests();

const storeUser = {
  id: 'store-1',
  roleKey: 'operations_officer',
  displayName: 'Store',
  permissions: ['operations.view', 'inventory.receive', 'production.manage'],
};

describe.skipIf(!mysqlOk)('operations snapshot receivable purchase orders', () => {
  it('includes Approved POs for store receive even with no in-transit load', () => {
    const db = createDatabase(':memory:', { seed: false });
    insertSupplier(db, { supplierID: 'S1', name: 'Supplier 1' });
    db.exec(`
      INSERT INTO purchase_orders (po_id, supplier_id, supplier_name, order_date_iso, status, branch_id)
      VALUES ('PO-KD-26-0099', 'S1', 'Supplier 1', '2026-09-16', 'Approved', 'BR-KD'),
             ('PO-KD-26-0001', 'S1', 'Supplier 1', '2026-01-01', 'Received', 'BR-KD'),
             ('PO-KD-26-0002', 'S1', 'Supplier 1', '2026-02-01', 'Pending', 'BR-KD');
      INSERT INTO purchase_order_lines (po_id, line_key, product_id, product_name, qty_ordered, qty_received)
      VALUES ('PO-KD-26-0099', 'L1', 'P1', 'Coil', 5000, 0),
             ('PO-KD-26-0001', 'L1', 'P1', 'Coil', 1000, 1000),
             ('PO-KD-26-0002', 'L1', 'P1', 'Coil', 2000, 0);
    `);

    const snap = buildOperationsDomainSnapshot(db, { user: storeUser, branchScope: 'BR-KD' });
    expect(snap.inTransitLoads).toEqual([]);
    expect(snap.purchaseOrders.map((p) => p.poID)).toEqual(['PO-KD-26-0099']);
    expect(snap.purchaseOrders[0].status).toBe('Approved');
    db.close();
  });

  it('statusKeys on listPurchaseOrders filters receipt-pending only', () => {
    const db = createDatabase(':memory:', { seed: false });
    insertSupplier(db, { supplierID: 'S1', name: 'Supplier 1' });
    db.exec(`
      INSERT INTO purchase_orders (po_id, supplier_id, supplier_name, order_date_iso, status, branch_id)
      VALUES ('PO-A', 'S1', 'Supplier 1', '2026-09-01', 'Approved', 'BR-KD'),
             ('PO-P', 'S1', 'Supplier 1', '2026-09-02', 'Pending', 'BR-KD');
    `);
    const rows = listPurchaseOrders(db, 'BR-KD', {
      skipSideEffects: true,
      statusKeys: ['approved', 'on loading', 'in transit'],
    });
    expect(rows.map((p) => p.poID)).toEqual(['PO-A']);
    db.close();
  });
});
