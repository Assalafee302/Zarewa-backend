/**
 * Cancelled production + cash above quote (lab / QT-KD-26-0029 pattern):
 * preview must suggest Order cancellation for full cash only — not Overpayment stack.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import { previewRefundRequest } from './controlOps.js';
import { validateRefundSameRequestOverlapCategoriesNgn } from '../shared/lib/refundQuotationMoney.js';

const LINES_JSON = JSON.stringify({
  products: [{ name: 'Roofing Sheet', qty: '40', unitPrice: '4500' }],
  accessories: [],
  services: [],
});

describe('refund preview — cancelled job with overpayment excess', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
    db.exec(`
      INSERT INTO customers (customer_id, name, branch_id, status)
      VALUES ('CUS-LAB', 'Refund Lab Customer', 'BR-KD', 'Active');
      INSERT INTO quotations (
        id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso
      ) VALUES (
        'QT-CANCEL-OVP', 'CUS-LAB', 'Refund Lab Customer', 180000, 260000, 'Paid', 'Finished',
        '${LINES_JSON.replace(/'/g, "''")}', '2026-05-01'
      );
      INSERT INTO sales_receipts (
        id, customer_id, customer_name, quotation_ref, amount_ngn, status, date_iso,
        finance_reconciliation_saved_at_iso, bank_confirmed_at_iso
      ) VALUES (
        'RCT-LAB', 'CUS-LAB', 'Refund Lab Customer', 'QT-CANCEL-OVP', 260000, 'Cleared', '2026-05-01',
        '2026-05-01T12:00:00.000Z', '2026-05-01T12:00:00.000Z'
      );
      INSERT INTO production_jobs (
        job_id, quotation_ref, customer_id, customer_name, status, planned_meters, actual_meters, created_at_iso
      ) VALUES (
        'PRO-CANCEL-LAB', 'QT-CANCEL-OVP', 'CUS-LAB', 'Refund Lab Customer', 'Cancelled', 40, 0,
        '2026-05-01T00:00:00.000Z'
      );
    `);
  });

  afterEach(() => {
    db?.close();
  });

  it('suggests Order cancellation for full cash-in only (no Overpayment line)', () => {
    const prev = previewRefundRequest(db, { quotationRef: 'QT-CANCEL-OVP' });
    expect(prev.ok).toBe(true);
    expect(prev.preview.hasCancelledProductionJob).toBe(true);
    expect(prev.preview.quotationCashInNgn).toBe(260_000);
    expect(prev.preview.overpaymentExcessNgn).toBe(80_000);
    expect(prev.preview.refundHardCapNgn).toBe(260_000);

    const lines = prev.preview.suggestedLines.filter((l) => Math.round(Number(l.amountNgn) || 0) > 0);
    const cats = lines.map((l) => l.category);
    expect(cats).toContain('Order cancellation');
    expect(cats).not.toContain('Overpayment');

    const cancelLine = lines.find((l) => l.category === 'Order cancellation');
    expect(cancelLine?.amountNgn).toBe(260_000);
    expect(prev.preview.suggestedAmountNgn).toBe(260_000);

    const overlap = validateRefundSameRequestOverlapCategoriesNgn(
      lines.map((l) => ({ ...l, include: true }))
    );
    expect(overlap.ok).toBe(true);
  });

  it('exposes open production job when a non-terminal job remains on quote', () => {
    db.prepare(
      `INSERT INTO production_jobs (
        job_id, quotation_ref, customer_id, customer_name, status, planned_meters, actual_meters, created_at_iso
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'PRO-PLANNED-LAB',
      'QT-CANCEL-OVP',
      'CUS-LAB',
      'Refund Lab Customer',
      'Planned',
      10,
      0,
      '2026-05-02T00:00:00.000Z'
    );

    const prev = previewRefundRequest(db, { quotationRef: 'QT-CANCEL-OVP' });
    expect(prev.ok).toBe(true);
    expect(prev.preview.openProductionJob?.jobId).toBe('PRO-PLANNED-LAB');
    expect(prev.preview.refundEligibilityOk).toBe(false);
    expect(String(prev.preview.refundEligibilityError || '')).toMatch(/Finish or cancel production/i);
    expect(prev.preview.warnings.some((w) => w.includes('PRO-PLANNED-LAB'))).toBe(true);
  });
});
