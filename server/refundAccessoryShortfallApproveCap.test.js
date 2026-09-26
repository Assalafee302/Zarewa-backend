import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import { previewRefundRequest, validateRefundFinancialGuards } from './controlOps.js';

/**
 * Regression: approving a pending Accessory shortfall refund must not treat that same
 * request as an open claim that hard-blocks / nets the category to ₦0 (missing system cap).
 */
describe('accessory shortfall approve-time system cap', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
    const linesJson = JSON.stringify({
      products: [{ name: 'Roofing Sheet', qty: 54.2, unitPrice: 4300, amount: 232_660 }],
      accessories: [
        { id: 'ACC-SCREW', name: 'Drive screw nail', qty: 8, unitPrice: 2500, amount: 20_000 },
      ],
      services: [],
    });
    db.prepare(
      `INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('QT-ACC-APPR', 'CUS-X', 'Mal Sul', 253060, 256500, 'Paid', 'Finished', linesJson);
    db.prepare(
      `INSERT INTO sales_receipts (id, customer_id, customer_name, quotation_ref, amount_ngn, status, date_iso)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run('RCT-ACC-APPR', 'CUS-X', 'Mal Sul', 'QT-ACC-APPR', 256500, 'Confirmed', '2026-09-17');
    db.prepare(
      `INSERT INTO production_jobs (job_id, quotation_ref, status, planned_meters, actual_meters, created_at_iso)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run('PRO-ACC-APPR', 'QT-ACC-APPR', 'Completed', 54.2, 54.2, '2026-09-17T12:00:00.000Z');
    db.prepare(
      `INSERT INTO production_job_accessory_usage
         (id, job_id, quotation_ref, quote_line_id, name, ordered_qty, supplied_qty, posted_at_iso)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'PAU-ACC-APPR',
      'PRO-ACC-APPR',
      'QT-ACC-APPR',
      'ACC-SCREW',
      'Drive screw nail',
      8,
      4,
      '2026-09-17T12:00:00.000Z'
    );

    const calcLines = [
      {
        category: 'Overpayment',
        label: 'Overpayment on QT-ACC-APPR',
        amountNgn: 3440,
        include: true,
      },
      {
        category: 'Accessory shortfall',
        label: 'Accessory shortfall: Drive screw nail (4 × ₦2,500)',
        amountNgn: 10_000,
        include: true,
      },
    ];
    db.prepare(
      `INSERT INTO customer_refunds (
         refund_id, quotation_ref, customer_id, customer_name, amount_ngn, status,
         reason_category, calculation_lines_json, requested_at_iso
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'RF-ACC-APPR',
      'QT-ACC-APPR',
      'CUS-X',
      'Mal Sul',
      13_440,
      'Pending',
      JSON.stringify(['Overpayment', 'Accessory shortfall']),
      JSON.stringify(calcLines),
      '2026-09-19T16:22:00.000Z'
    );
  });

  afterEach(() => {
    db?.close();
  });

  it('preview without exclude blocks Accessory shortfall (open claim on self)', () => {
    const prev = previewRefundRequest(db, { quotationRef: 'QT-ACC-APPR' });
    expect(prev.ok).toBe(true);
    const acc = (prev.preview.suggestedLines || []).filter((l) => l.category === 'Accessory shortfall');
    expect(acc).toHaveLength(0);
    expect(prev.preview.categorySuggestedMaxNgn?.['Accessory shortfall'] ?? 0).toBe(0);
  });

  it('preview excluding the pending refund restores Accessory shortfall system cap', () => {
    const prev = previewRefundRequest(db, {
      quotationRef: 'QT-ACC-APPR',
      excludeRefundId: 'RF-ACC-APPR',
    });
    expect(prev.ok).toBe(true);
    const acc = (prev.preview.suggestedLines || []).filter((l) => l.category === 'Accessory shortfall');
    expect(acc.some((l) => l.amountNgn === 10_000)).toBe(true);
    expect(prev.preview.categorySuggestedMaxNgn?.['Accessory shortfall']).toBe(10_000);
  });

  it('validateRefundFinancialGuards allows approve when refundId excludes self', () => {
    let calcLines = [];
    try {
      const row = db
        .prepare(`SELECT calculation_lines_json FROM customer_refunds WHERE refund_id = ?`)
        .get('RF-ACC-APPR');
      calcLines = JSON.parse(String(row.calculation_lines_json || '[]'));
    } catch {
      calcLines = [];
    }
    const r = validateRefundFinancialGuards(db, {
      quotationRef: 'QT-ACC-APPR',
      refundId: 'RF-ACC-APPR',
      amountNgn: 13_440,
      calculationLines: calcLines,
      reasonCategories: ['Overpayment', 'Accessory shortfall'],
      phase: 'approve',
      actor: { role: 'Administrator' },
      hasPermission: () => true,
    });
    expect(r.ok).toBe(true);
  });
});
