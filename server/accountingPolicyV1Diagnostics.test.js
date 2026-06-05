import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import {
  countAccountingPolicyV1Diagnostics,
} from './accountingPolicyV1Diagnostics.js';
import { evaluateQuotationPaymentForDeliveryRelease } from './deliveryReleaseGate.js';

const mysqlTestReady = Boolean(String(process.env.ZAREWA_MYSQL_PASSWORD || '').trim());

describe.skipIf(!mysqlTestReady)('accountingPolicyV1Diagnostics', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
    db.exec(`
      INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso)
      VALUES
        ('QT-PRE', 'C1', 'Cust', 100000, 50000, 'Partial', 'Approved', '{}', '2026-06-01'),
        ('QT-PAID', 'C1', 'Cust', 100000, 100000, 'Paid', 'Approved', '{}', '2026-06-01'),
        ('QT-AR', 'C1', 'Cust', 100000, 0, 'Unpaid', 'Approved', '{}', '2026-06-01');
      INSERT INTO production_jobs (id, quotation_ref, status, actual_meters, completed_at_iso, branch_id)
      VALUES ('PJ-1', 'QT-AR', 'Completed', 50, '2026-06-02T10:00:00.000Z', 'BR-001');
      INSERT INTO deliveries (id, quotation_ref, customer_name, status, branch_id)
      VALUES ('DL-1', 'QT-AR', 'Cust', 'Scheduled', 'BR-001');
    `);
  });

  afterEach(() => {
    db?.close();
  });

  it('evaluateQuotationPaymentForDeliveryRelease when unpaid after production', () => {
    const jobs = db.prepare(`SELECT * FROM production_jobs WHERE quotation_ref = 'QT-AR'`).all();
    const mapped = jobs.map((j) => ({
      status: j.status,
      quotationRef: j.quotation_ref,
      actualMeters: j.actual_meters,
    }));
    const r = evaluateQuotationPaymentForDeliveryRelease(db, 'QT-AR', mapped);
    expect(r.wouldBlock).toBe(true);
    expect(r.reason).toBe('unpaid_after_production');
  });

  it('countAccountingPolicyV1Diagnostics includes pre-production balance due', () => {
    const c = countAccountingPolicyV1Diagnostics(db, 'ALL');
    expect(c.quotationsPreProductionWithBalanceDue).toBeGreaterThanOrEqual(1);
    expect(c.openDeliveriesWouldBlockOnPayment).toBeGreaterThanOrEqual(1);
  });
});
