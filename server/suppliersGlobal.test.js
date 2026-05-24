import { describe, it, expect, beforeEach } from 'vitest';
import { createDatabase } from './db.js';
import { listSuppliers, listTransportAgents, listPurchaseOrders } from './readModel.js';
import { insertSupplier, insertTransportAgent } from './writeOps.js';
import { DEFAULT_BRANCH_ID } from './branches.js';

describe('global suppliers and transporters', () => {
  /** @type {import('better-sqlite3').Database} */
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:', { seed: false });
  });

  it('lists all suppliers regardless of workspace branch scope', () => {
    insertSupplier(db, { supplierID: 'SUP-A', name: 'Alpha Metals' }, DEFAULT_BRANCH_ID);
    db.prepare(
      `INSERT INTO suppliers (supplier_id, name, city, payment_terms, quality_score, notes, branch_id)
       VALUES ('SUP-B', 'Beta Steel', 'Maiduguri', 'Credit', 80, '', 'BR-MDG')`
    ).run();

    const yola = listSuppliers(db, 'BR-YL');
    const mdg = listSuppliers(db, 'BR-MDG');
    expect(yola).toHaveLength(2);
    expect(mdg.map((s) => s.supplierID).sort()).toEqual(['SUP-A', 'SUP-B']);
  });

  it('lists purchase orders only for the active branch', () => {
    insertSupplier(db, { supplierID: 'SUP-A', name: 'Alpha Metals' }, DEFAULT_BRANCH_ID);
    db.prepare(
      `INSERT INTO purchase_orders (
        po_id, supplier_id, supplier_name, order_date_iso, expected_delivery_iso, status, branch_id, procurement_kind
      ) VALUES ('PO-YL-1', 'SUP-A', 'Alpha Metals', '2026-05-01', '', 'Pending', 'BR-YL', 'coil'),
             ('PO-MDG-1', 'SUP-A', 'Alpha Metals', '2026-05-02', '', 'Pending', 'BR-MDG', 'coil')`
    ).run();

    const yolaPos = listPurchaseOrders(db, 'BR-YL');
    const mdgPos = listPurchaseOrders(db, 'BR-MDG');
    expect(yolaPos.map((p) => p.poID)).toEqual(['PO-YL-1']);
    expect(mdgPos.map((p) => p.poID)).toEqual(['PO-MDG-1']);
  });

  it('lists all transport agents regardless of branch scope', () => {
    insertTransportAgent(db, { id: 'AG-1', name: 'Haulier One' }, DEFAULT_BRANCH_ID);
    db.prepare(
      `INSERT INTO transport_agents (id, name, region, phone, branch_id) VALUES ('AG-2', 'Haulier Two', 'NE', '', 'BR-MDG')`
    ).run();
    expect(listTransportAgents(db, 'BR-YL')).toHaveLength(2);
    expect(listTransportAgents(db, 'BR-MDG')).toHaveLength(2);
  });
});
