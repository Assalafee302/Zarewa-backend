import { describe, it, expect } from 'vitest';
import {
  findDuplicateQuotationCandidateIds,
  paymentIntegrityIssuesForQuotation,
} from './customerPaymentIntegrity.js';

describe('customerPaymentIntegrity', () => {
  it('finds duplicate quotation candidates same total and date window', () => {
    const quotations = [
      { id: 'QT-0150', customerID: 'CUS-1', totalNgn: 564_540, dateISO: '2026-05-11' },
      { id: 'QT-0154', customerID: 'CUS-1', totalNgn: 564_540, dateISO: '2026-05-11' },
    ];
    expect(
      findDuplicateQuotationCandidateIds(quotations, {
        customerId: 'CUS-1',
        quotationId: 'QT-0150',
        totalNgn: 564_540,
        dateISO: '2026-05-11',
      })
    ).toEqual(['QT-0154']);
  });

  it('flags settled quote repeat payment', () => {
    const issues = paymentIntegrityIssuesForQuotation({
      quotationId: 'QT-0150',
      quoteTotalNgn: 564_540,
      receiptCashNgn: 580_400,
      cashInNgn: 580_400,
      settledQuoteFullOverpayNgn: 580_400,
      duplicateQuotationIds: ['QT-0154'],
    });
    expect(issues.some((i) => i.code === 'settled_quote_repeat_payment')).toBe(true);
    expect(issues.some((i) => i.code === 'duplicate_quotation_same_total')).toBe(true);
  });
});
