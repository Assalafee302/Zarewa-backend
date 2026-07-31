import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import {
  quotationPaymentCashBreakdown,
  quotationPaymentCashBreakdownByRef,
} from './quotationPaymentCash.js';
import { previewRefundRequest, quotationMeetsRefundEligibility } from './controlOps.js';
import { refundPaymentIntegrityIssues } from './customerPaymentIntegrityOps.js';

describe('quotation payment integrity (duplicate entry)', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
    db.exec(`
      INSERT INTO quotations (id, customer_id, customer_name, total_ngn, paid_ngn, payment_status, status, lines_json, date_iso)
      VALUES ('QT-A', 'CUS-1', 'Test', 564540, 564540, 'Paid', 'Finished', '{}', '2026-05-11');
      INSERT INTO sales_receipts (id, customer_id, customer_name, quotation_ref, amount_ngn, status, date_iso)
      VALUES ('LE-A', 'CUS-1', 'Test', 'QT-A', 564540, 'Posted', '2026-05-11');
      INSERT INTO ledger_entries (id, type, customer_id, quotation_ref, amount_ngn, at_iso, note)
      VALUES
        ('LE-R', 'RECEIPT', 'CUS-1', 'QT-A', 564540, '2026-05-11T12:00:00.000Z', 'Settlement'),
        ('LE-O1', 'OVERPAY_ADVANCE', 'CUS-1', 'QT-A', 15860, '2026-05-11T12:00:00.000Z', 'Overpayment vs remaining balance on QT-A → advance'),
        ('LE-O2', 'OVERPAY_ADVANCE', 'CUS-1', 'QT-A', 580400, '2026-05-11T12:01:00.000Z', 'Quote QT-A already settled in records — full payment to customer advance');
      INSERT INTO production_jobs (job_id, quotation_ref, status)
      VALUES ('PRO-A', 'QT-A', 'Completed');
    `);
  });

  afterEach(() => {
    db?.close();
  });

  it('cash in uses receipt cash only when settled-quote overpay duplicates till', () => {
    const cash = quotationPaymentCashBreakdown(db, 'QT-A');
    expect(cash.receiptCashNgn).toBe(580_400);
    expect(cash.cashInNgn).toBe(580_400);
    const meets = quotationMeetsRefundEligibility(db, 'QT-A');
    expect(meets.ok).toBe(true);
    expect(meets.remainingNgn).toBe(15_860);
  });

  it('batch cash breakdown matches single-quote breakdown', () => {
    const single = quotationPaymentCashBreakdown(db, 'QT-A');
    const batch = quotationPaymentCashBreakdownByRef(db, ['QT-A', 'QT-MISSING']);
    expect(batch.get('QT-A')).toEqual(single);
    expect(batch.get('QT-MISSING')?.cashInNgn).toBe(0);
  });

  it('preview overpayment suggestion matches per-quote headroom', () => {
    const prev = previewRefundRequest(db, { quotationRef: 'QT-A' });
    expect(prev.ok).toBe(true);
    expect(prev.preview.remainingRefundableNgn).toBe(15_860);
    const over = prev.preview.suggestedLines.find((l) => l.category === 'Overpayment');
    expect(over?.amountNgn).toBe(15_860);
  });

  it('emits payment integrity issues for duplicate posting', () => {
    const issues = refundPaymentIntegrityIssues(db, 'QT-A');
    expect(issues.some((i) => i.code === 'settled_quote_repeat_payment')).toBe(true);
  });
});
