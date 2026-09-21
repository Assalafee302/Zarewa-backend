import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from '../db.js';
import { updateQuotation } from '../writeOps.js';
import { listRefunds } from '../readModel.js';

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

describe.skipIf(!mysqlOk)('quotation customer reassignment cascades to open refunds', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
    db.prepare(
      `INSERT OR REPLACE INTO customers (customer_id, name, branch_id, status)
       VALUES
         ('CUS-OLD', 'Old Customer', 'BR-KD', 'Active'),
         ('CUS-NEW', 'New Customer', 'BR-KD', 'Active')`
    ).run();
    db.prepare(
      `INSERT OR REPLACE INTO quotations (
         id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, branch_id, date_iso
       ) VALUES (
         'QT-REASSIGN-1', 'CUS-OLD', 'Old Customer', 100000, 120000, 'Paid', 'Finished',
         '{"products":[],"accessories":[],"services":[]}', 'BR-KD', '2026-09-01'
       )`
    ).run();
    db.prepare(
      `INSERT INTO customer_refunds (
         refund_id, customer_id, customer_name, quotation_ref, reason_category, reason,
         amount_ngn, status, requested_at_iso, approved_amount_ngn, branch_id
       ) VALUES (
         'RF-REASSIGN-1', 'CUS-OLD', 'Old Customer', 'QT-REASSIGN-1', 'Overpayment', 'Overpay',
         20000, 'Approved', '2026-09-02T10:00:00.000Z', 20000, 'BR-KD'
       )`
    ).run();
  });

  afterEach(() => {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  });

  it('updates open refund customer id/name so Cashier desk list shows the new name', () => {
    updateQuotation(db, 'QT-REASSIGN-1', { customerID: 'CUS-NEW' });

    const row = db
      .prepare(`SELECT customer_id, customer_name, status FROM customer_refunds WHERE refund_id = ?`)
      .get('RF-REASSIGN-1');
    expect(row.customer_id).toBe('CUS-NEW');
    expect(row.customer_name).toBe('New Customer');
    expect(row.status).toBe('Approved');

    const listed = listRefunds(db, 'BR-KD');
    const refund = listed.find((r) => r.refundID === 'RF-REASSIGN-1');
    expect(refund).toBeTruthy();
    expect(refund.customerID).toBe('CUS-NEW');
    expect(refund.customer).toBe('New Customer');
  });

  it('heals a stale open refund when the quote is saved again after an earlier reassignment', () => {
    db.prepare(
      `UPDATE quotations SET customer_id = ?, customer_name = ? WHERE id = ?`
    ).run('CUS-NEW', 'New Customer', 'QT-REASSIGN-1');

    updateQuotation(db, 'QT-REASSIGN-1', { projectName: 'Heal cascade' });

    const row = db
      .prepare(`SELECT customer_id, customer_name FROM customer_refunds WHERE refund_id = ?`)
      .get('RF-REASSIGN-1');
    expect(row.customer_id).toBe('CUS-NEW');
    expect(row.customer_name).toBe('New Customer');
  });

  it('does not rewrite a fully paid refund customer snapshot', () => {
    db.prepare(`UPDATE customer_refunds SET status = 'Paid', paid_amount_ngn = 20000 WHERE refund_id = ?`).run(
      'RF-REASSIGN-1'
    );
    updateQuotation(db, 'QT-REASSIGN-1', { customerID: 'CUS-NEW' });
    const row = db
      .prepare(`SELECT customer_id, customer_name FROM customer_refunds WHERE refund_id = ?`)
      .get('RF-REASSIGN-1');
    expect(row.customer_id).toBe('CUS-OLD');
    expect(row.customer_name).toBe('Old Customer');
  });
});
