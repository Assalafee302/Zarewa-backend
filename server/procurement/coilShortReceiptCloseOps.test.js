import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from '../db.js';
import { closeHangingCoilShortReceipts } from './coilShortReceiptCloseOps.js';

function dbReady() {
  try {
    const db = createDatabase(':memory:', { seed: false });
    db.close();
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!dbReady())('closeHangingCoilShortReceipts', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
    db.prepare(
      `INSERT INTO purchase_orders (
         po_id, supplier_id, supplier_name, order_date_iso, status, branch_id
       ) VALUES (?, ?, ?, ?, ?, ?)`
    ).run('PO-SHORT-1', 'SUP-1', 'Mill Co', '2026-04-01', 'In Transit', 'BR-KD');
    db.prepare(
      `INSERT INTO purchase_order_lines (
         po_id, line_key, product_id, product_name, color, gauge,
         qty_ordered, qty_received, unit_price_ngn, unit_price_per_kg_ngn, line_type
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('PO-SHORT-1', 'L1', 'COIL-ALU', 'Aluminium coil', 'TB', '0.22', 5000, 4800, 100, 100, 'coil_kg');
  });

  afterEach(() => {
    db?.close();
  });

  it('snaps short coil GRN lines closed and marks the PO received', () => {
    const result = closeHangingCoilShortReceipts(db);
    expect(result.linesClosed).toBe(1);
    expect(result.posReceived).toBe(1);
    const line = db
      .prepare(`SELECT qty_ordered, qty_received FROM purchase_order_lines WHERE po_id = ?`)
      .get('PO-SHORT-1');
    expect(Number(line.qty_received)).toBe(5000);
    const po = db.prepare(`SELECT status FROM purchase_orders WHERE po_id = ?`).get('PO-SHORT-1');
    expect(po.status).toBe('Received');
  });

  it('leaves unreceived coil lines as open commitment', () => {
    db.prepare(`UPDATE purchase_order_lines SET qty_received = 0 WHERE po_id = ?`).run('PO-SHORT-1');
    const result = closeHangingCoilShortReceipts(db);
    expect(result.linesClosed).toBe(0);
    expect(result.posReceived).toBe(0);
    const po = db.prepare(`SELECT status FROM purchase_orders WHERE po_id = ?`).get('PO-SHORT-1');
    expect(po.status).toBe('In Transit');
  });
});
