import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import {
  quotationCashInNgn,
  quotationMeetsRefundEligibility,
  previewRefundRequest,
} from './controlOps.js';

describe('quotation refund headroom (cash on quote − quote total)', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
    db.exec(`
      INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json)
      VALUES ('QT-OVR-SPLIT', 'CUS-X', 'Test', 172800, 172800, 'Paid', 'Finished', '{}');
      INSERT INTO sales_receipts (id, customer_id, customer_name, quotation_ref, amount_ngn, status, date_iso)
      VALUES ('RCT-1', 'CUS-X', 'Test', 'QT-OVR-SPLIT', 172800, 'Confirmed', '2026-05-15');
      INSERT INTO ledger_entries (id, type, customer_id, quotation_ref, amount_ngn, at_iso)
      VALUES ('LE-OVP', 'OVERPAY_ADVANCE', 'CUS-X', 'QT-OVR-SPLIT', 287200, '2026-05-15T12:00:00.000Z');
      INSERT INTO production_jobs (job_id, quotation_ref, status)
      VALUES ('PRO-1', 'QT-OVR-SPLIT', 'Completed');
    `);
  });

  afterEach(() => {
    db?.close();
  });

  it('cash in is booked paid plus overpay credit on this quote only', () => {
    expect(quotationCashInNgn(db, 'QT-OVR-SPLIT')).toBe(460_000);
  });

  it('eligibility hard cap is full cash received on quote', () => {
    const meets = quotationMeetsRefundEligibility(db, 'QT-OVR-SPLIT');
    expect(meets.ok).toBe(true);
    expect(meets.remainingNgn).toBe(460_000);
    expect(meets.overpaymentExcessNgn).toBe(287_200);
  });

  it('preview suggests full overpayment line and matching remaining', () => {
    const prev = previewRefundRequest(db, { quotationRef: 'QT-OVR-SPLIT' });
    expect(prev.ok).toBe(true);
    expect(prev.preview.quotationCashInNgn).toBe(460_000);
    expect(prev.preview.remainingRefundableNgn).toBe(287_200);
    const overLine = prev.preview.suggestedLines.find((l) => l.category === 'Overpayment');
    expect(overLine?.amountNgn).toBe(287_200);
  });

  it('subtracts leftover overpay already applied to another quotation from remaining', () => {
    db.exec(`
      INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json)
      VALUES ('QT-OTHER', 'CUS-X', 'Test', 80000, 0, 'Unpaid', 'Draft', '{}');
      INSERT INTO refund_credit_applications (
        application_id, customer_id, target_quotation_ref, source_quotation_ref, refund_id,
        kind, amount_ngn, status, created_at_iso
      ) VALUES (
        'RCA-OVR-1', 'CUS-X', 'QT-OTHER', 'QT-OVR-SPLIT', '',
        'overpay', 100000, 'Credit confirmation', '2026-05-16T12:00:00.000Z'
      );
    `);
    const prev = previewRefundRequest(db, { quotationRef: 'QT-OVR-SPLIT' });
    expect(prev.ok).toBe(true);
    expect(prev.preview.creditAppliedOutNgn).toBe(100_000);
    expect(prev.preview.overpaymentResidualNgn).toBe(187_200);
    expect(prev.preview.remainingRefundableNgn).toBe(187_200);
    const overLine = prev.preview.suggestedLines.find((l) => l.category === 'Overpayment');
    expect(overLine?.amountNgn).toBe(187_200);
    expect(String(prev.preview.warnings.join(' '))).toMatch(/already used on another quotation/i);
  });
});
