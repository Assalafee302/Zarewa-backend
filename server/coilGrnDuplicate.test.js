/**
 * coil_no is a global primary key. A Yola store receipt must not crash when the
 * suggested CL-YY number already exists on another branch or on a consumed lot.
 */
import { describe, expect, it } from 'vitest';
import { createDatabase } from './db.js';
import { confirmGrn, insertSupplier, nextFreeClCoilNo } from './writeOps.js';
import { isMysqlAvailableForTests } from './testIntegrationHarness.js';

const mysqlOk = isMysqlAvailableForTests();

describe.skipIf(!mysqlOk)('coil GRN duplicate numbers', () => {
  it('rejects a number already used on a consumed Kaduna coil and names the next free one', () => {
    const db = createDatabase(':memory:', { seed: false });
    const yy = String(new Date().getFullYear()).slice(-2);
    const taken = `CL-${yy}-0001`;
    insertSupplier(db, { supplierID: 'S-YL', name: 'Yola Mill' });
    db.prepare(
      `INSERT INTO products (product_id, name, stock_level, unit, branch_id)
       VALUES ('COIL-ALU', 'Aluminium coil', 0, 'kg', '')`
    ).run();
    db.prepare(
      `INSERT INTO coil_lots (
         coil_no, product_id, branch_id, qty_received, qty_remaining, current_weight_kg, weight_kg, current_status
       ) VALUES (?, 'COIL-ALU', 'BR-KD', 800, 0, 0, 800, 'Consumed')`
    ).run(taken);
    db.prepare(
      `INSERT INTO purchase_orders (po_id, supplier_id, supplier_name, order_date_iso, status, branch_id)
       VALUES ('PO-YL-1', 'S-YL', 'Yola Mill', '2026-09-28', 'Approved', 'BR-YL')`
    ).run();
    db.prepare(
      `INSERT INTO purchase_order_lines (po_id, line_key, product_id, product_name, qty_ordered, qty_received)
       VALUES ('PO-YL-1', 'L1', 'COIL-ALU', 'Aluminium coil', 1000, 0)`
    ).run();

    expect(nextFreeClCoilNo(db)).toBe(`CL-${yy}-0002`);

    const blocked = confirmGrn(
      db,
      'PO-YL-1',
      [{ lineKey: 'L1', productID: 'COIL-ALU', qtyReceived: 1000, weightKg: 1000, coilNo: taken }],
      'S-YL',
      'Yola Mill',
      'BR-YL'
    );
    expect(blocked.ok).toBe(false);
    expect(blocked.code).toBe('COIL_NO_TAKEN');
    expect(blocked.nextCoilNo).toBe(`CL-${yy}-0002`);
    expect(String(blocked.error)).toContain(taken);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM coil_lots WHERE po_id = 'PO-YL-1'`).get().n).toBe(0);

    const posted = confirmGrn(
      db,
      'PO-YL-1',
      [
        {
          lineKey: 'L1',
          productID: 'COIL-ALU',
          qtyReceived: 1000,
          weightKg: 1000,
          coilNo: blocked.nextCoilNo,
        },
      ],
      'S-YL',
      'Yola Mill',
      'BR-YL'
    );
    expect(posted.ok).toBe(true);
    expect(posted.coilNos).toEqual([blocked.nextCoilNo]);
    const lot = db.prepare(`SELECT branch_id, qty_remaining FROM coil_lots WHERE coil_no = ?`).get(blocked.nextCoilNo);
    expect(lot.branch_id).toBe('BR-YL');
    expect(Number(lot.qty_remaining)).toBe(1000);
    db.close();
  });
});
