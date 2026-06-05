import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import { buildAp2SupplierDiagnosticsReport } from './ap2SupplierDiagnosticsOps.js';

const mysqlTestReady = Boolean(String(process.env.ZAREWA_MYSQL_PASSWORD || '').trim());

describe.skipIf(!mysqlTestReady)('ap2SupplierDiagnostics', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
    db.exec(`
      INSERT INTO purchase_orders (
        po_id, supplier_id, supplier_name, order_date_iso, status, branch_id, supplier_paid_ngn
      ) VALUES (
        'PO-AP2-1', 'SUP-1', 'Steel Co', '2026-06-01', 'Approved', 'BR-KD', 500000
      );
      INSERT INTO purchase_order_lines (
        po_id, line_key, product_id, product_name, unit_price_ngn, qty_ordered, qty_received, line_type
      ) VALUES (
        'PO-AP2-1', 'L1', 'P1', 'Coil', 100000, 10, 6, 'coil'
      );
      INSERT INTO accounts_payable (
        ap_id, supplier_name, po_ref, invoice_ref, amount_ngn, paid_ngn, due_date_iso
      ) VALUES (
        'AP-PO-PO-AP2-1', 'Steel Co', 'PO-AP2-1', 'INV-1', 1000000, 500000, '2026-06-30'
      );
    `);
  });

  afterEach(() => {
    db?.close();
  });

  it('computes ordered and received values', () => {
    const r = buildAp2SupplierDiagnosticsReport(db, { branchId: 'BR-KD' });
    expect(r.status).toBe('diagnostics_only');
    expect(r.summary.poOrderedValueNgn).toBe(1_000_000);
    expect(r.summary.grnReceivedValueNgn).toBe(600_000);
    expect(r.poRows[0].orderedValueNgn).toBe(1_000_000);
    expect(r.poRows[0].receivedValueNgn).toBe(600_000);
  });

  it('expected AP by received basis', () => {
    const r = buildAp2SupplierDiagnosticsReport(db, {});
    const row = r.poRows.find((x) => x.poId === 'PO-AP2-1');
    expect(row.expectedApNgn).toBe(100_000);
    expect(row.receivedNotPaidNgn).toBe(100_000);
  });

  it('paid not received when paid exceeds received', () => {
    db.prepare(`UPDATE purchase_orders SET supplier_paid_ngn = 800000 WHERE po_id = 'PO-AP2-1'`).run();
    const r = buildAp2SupplierDiagnosticsReport(db, {});
    const row = r.poRows[0];
    expect(row.paidNotReceivedNgn).toBe(200_000);
    expect(row.flags.overpaid).toBe(true);
  });

  it('AP difference vs current AP', () => {
    const r = buildAp2SupplierDiagnosticsReport(db, {});
    const row = r.poRows[0];
    expect(row.currentApNgn).toBe(1_000_000);
    expect(row.apDifferenceNgn).toBe(row.currentApNgn - row.expectedApNgn);
  });

  it('detects payable without GRN', () => {
    db.prepare(`UPDATE purchase_order_lines SET qty_received = 0 WHERE po_id = 'PO-AP2-1'`).run();
    const r = buildAp2SupplierDiagnosticsReport(db, {});
    expect(r.summary.payableWithoutGrnCount).toBe(1);
    expect(r.poRows[0].flags.payableWithoutGrn).toBe(true);
  });

  it('branch filtering', () => {
    db.exec(`
      INSERT INTO purchase_orders (po_id, supplier_id, supplier_name, order_date_iso, status, branch_id, supplier_paid_ngn)
      VALUES ('PO-AP2-YL', 'SUP-2', 'Other', '2026-06-02', 'Approved', 'BR-YL', 0);
      INSERT INTO purchase_order_lines (po_id, line_key, product_id, unit_price_ngn, qty_ordered, qty_received, line_type)
      VALUES ('PO-AP2-YL', 'L1', 'P2', 50000, 2, 0, 'coil');
    `);
    const r = buildAp2SupplierDiagnosticsReport(db, { branchId: 'BR-KD' });
    expect(r.poRowCount).toBe(1);
    expect(r.poRows[0].poId).toBe('PO-AP2-1');
  });

  it('does not mutate AP', () => {
    buildAp2SupplierDiagnosticsReport(db, {});
    const ap = db.prepare(`SELECT amount_ngn FROM accounts_payable WHERE po_ref = 'PO-AP2-1'`).get();
    expect(ap.amount_ngn).toBe(1_000_000);
  });
});

describe('ap2SupplierDiagnostics (empty db tables)', () => {
  it('returns diagnostics_only when no PO table data', () => {
    const db = createDatabase(':memory:');
    try {
      const r = buildAp2SupplierDiagnosticsReport(db, {});
      expect(r.ok).toBe(true);
      expect(r.status).toBe('diagnostics_only');
    } finally {
      db.close();
    }
  });
});
