import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import {
  validateProducedMetresEditAgainstPaidRefunds,
  validateAccessoryCorrectionAgainstPaidRefunds,
  loadActiveRefundShortfallCaps,
} from './refundPaidProductionEditGate.js';

describe('refundPaidProductionEditGate', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
    db.prepare(
      `INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, status, lines_json)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'QT-CAP',
      'CUS-X',
      'Cap',
      192000,
      192000,
      'Finished',
      JSON.stringify({
        products: [{ name: 'Roofing Sheet', qty: 40, unitPrice: 4800 }],
        accessories: [{ id: 'ACC-1', name: 'Ridge cap', qty: 20, unitPrice: 1000 }],
        services: [],
      })
    );
    db.prepare(
      `INSERT INTO production_jobs (job_id, quotation_ref, status, actual_meters, created_at_iso)
       VALUES (?, ?, ?, ?, ?)`
    ).run('PRO-CAP', 'QT-CAP', 'Completed', 28, '2026-04-01T12:00:00.000Z');
    db.prepare(
      `INSERT INTO customer_refunds (
         refund_id, quotation_ref, customer_id, customer_name, amount_ngn,
         calculation_lines_json, paid_amount_ngn, status
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'RF-CAP',
      'QT-CAP',
      'CUS-X',
      'Cap',
      57600,
      JSON.stringify([
        {
          category: 'Unproduced meterage',
          label: 'Unproduced metres (12.00m @ ₦4,800)',
          amountNgn: 57600,
          include: true,
        },
      ]),
      57600,
      'Paid'
    );
  });

  afterEach(() => {
    db?.close();
  });

  it('blocks increasing produced metres above post-refund cap', () => {
    const ok = validateProducedMetresEditAgainstPaidRefunds(db, 'QT-CAP', 'PRO-CAP', 30);
    expect(ok.ok).toBe(false);
    expect(String(ok.error)).toMatch(/paid unproduced-meterage refund/i);
    const allow = validateProducedMetresEditAgainstPaidRefunds(db, 'QT-CAP', 'PRO-CAP', 28);
    expect(allow.ok).toBe(true);
  });

  it('blocks increasing accessory supplied above post-refund cap', () => {
    db.prepare(`UPDATE customer_refunds SET calculation_lines_json = ? WHERE refund_id = ?`).run(
      JSON.stringify([
        {
          category: 'Accessory shortfall',
          label: 'Accessory shortfall: Ridge cap (5 × ₦1,000)',
          amountNgn: 5000,
          include: true,
        },
      ]),
      'RF-CAP'
    );
    db.prepare(
      `INSERT INTO production_job_accessory_usage
         (id, job_id, quotation_ref, quote_line_id, name, ordered_qty, supplied_qty, posted_at_iso)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('PAU-CAP', 'PRO-CAP', 'QT-CAP', 'ACC-1', 'Ridge cap', 20, 15, '2026-04-01T12:00:00.000Z');
    const blocked = validateAccessoryCorrectionAgainstPaidRefunds(db, 'QT-CAP', 'PRO-CAP', [
      { quoteLineId: 'ACC-1', name: 'Ridge cap', suppliedQty: 16 },
    ]);
    expect(blocked.ok).toBe(false);
    const allowed = validateAccessoryCorrectionAgainstPaidRefunds(db, 'QT-CAP', 'PRO-CAP', [
      { quoteLineId: 'ACC-1', name: 'Ridge cap', suppliedQty: 15 },
    ]);
    expect(allowed.ok).toBe(true);
  });

  it('loadActiveRefundShortfallCaps excludes the refund being re-previewed', () => {
    db.prepare(`UPDATE customer_refunds SET calculation_lines_json = ?, status = ? WHERE refund_id = ?`).run(
      JSON.stringify([
        {
          category: 'Accessory shortfall',
          label: 'Accessory shortfall: Ridge cap (5 × ₦1,000)',
          amountNgn: 5000,
          include: true,
        },
      ]),
      'Pending',
      'RF-CAP'
    );
    const withSelf = loadActiveRefundShortfallCaps(db, 'QT-CAP');
    expect(withSelf.accessoryShortfallByKey.get('ridge cap')).toBe(5);

    const withoutSelf = loadActiveRefundShortfallCaps(db, 'QT-CAP', 'RF-CAP');
    expect(withoutSelf.accessoryShortfallByKey.get('ridge cap') || 0).toBe(0);
  });
});
