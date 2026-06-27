import { describe, it, expect, beforeEach } from 'vitest';
import { createDatabase } from './db.js';
import {
  validateProducedMetresEditAgainstPaidRefunds,
  validateAccessoryCorrectionAgainstPaidRefunds,
} from './refundPaidProductionEditGate.js';

describe('refundPaidProductionEditGate', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
    db.exec(`
      CREATE TABLE quotations (id TEXT PRIMARY KEY, lines_json TEXT);
      CREATE TABLE production_jobs (
        job_id TEXT PRIMARY KEY, quotation_ref TEXT, status TEXT, actual_meters REAL
      );
      CREATE TABLE production_completion_adjustments (
        id TEXT PRIMARY KEY, job_id TEXT, delta_finished_goods_m REAL
      );
      CREATE TABLE customer_refunds (
        refund_id TEXT PRIMARY KEY, quotation_ref TEXT, calculation_lines_json TEXT,
        paid_amount_ngn INTEGER, status TEXT
      );
      CREATE TABLE production_job_accessory_usage (
        job_id TEXT, quotation_ref TEXT, quote_line_id TEXT, name TEXT, supplied_qty REAL
      );
    `);
    db.prepare(`INSERT INTO quotations (id, lines_json) VALUES (?, ?)`).run(
      'QT-CAP',
      JSON.stringify({
        products: [{ name: 'Roofing Sheet', qty: 40, unitPrice: 4800 }],
        accessories: [{ id: 'ACC-1', name: 'Ridge cap', qty: 20, unitPrice: 1000 }],
        services: [],
      })
    );
    db.prepare(
      `INSERT INTO production_jobs (job_id, quotation_ref, status, actual_meters) VALUES (?, ?, ?, ?)`
    ).run('PRO-CAP', 'QT-CAP', 'Completed', 28);
    db.prepare(
      `INSERT INTO customer_refunds (refund_id, quotation_ref, calculation_lines_json, paid_amount_ngn, status)
       VALUES (?, ?, ?, ?, ?)`
    ).run(
      'RF-CAP',
      'QT-CAP',
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
      `INSERT INTO production_job_accessory_usage (job_id, quotation_ref, quote_line_id, name, supplied_qty)
       VALUES ('PRO-CAP', 'QT-CAP', 'ACC-1', 'Ridge cap', 15)`
    ).run();
    const blocked = validateAccessoryCorrectionAgainstPaidRefunds(db, 'QT-CAP', 'PRO-CAP', [
      { quoteLineId: 'ACC-1', name: 'Ridge cap', suppliedQty: 16 },
    ]);
    expect(blocked.ok).toBe(false);
    const allowed = validateAccessoryCorrectionAgainstPaidRefunds(db, 'QT-CAP', 'PRO-CAP', [
      { quoteLineId: 'ACC-1', name: 'Ridge cap', suppliedQty: 15 },
    ]);
    expect(allowed.ok).toBe(true);
  });
});
