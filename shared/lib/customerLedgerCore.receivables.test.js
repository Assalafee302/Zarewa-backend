import { describe, expect, it } from 'vitest';
import {
  amountDueOnQuotationFromEntries,
  quotationHasCompletedProduction,
  receivableDueOnQuotationFromEntries,
} from './customerLedgerCore.js';

describe('receivableDueOnQuotationFromEntries', () => {
  const quote = { id: 'QT-1', totalNgn: 100_000, paidNgn: 40_000 };
  const jobs = [
    {
      status: 'Completed',
      quotationRef: 'QT-1',
      actualMeters: 50,
      completedAtISO: '2026-05-10T10:00:00Z',
    },
  ];

  it('excludes unpaid quotes with no completed production', () => {
    expect(amountDueOnQuotationFromEntries([], quote)).toBe(60_000);
    expect(quotationHasCompletedProduction('QT-1', [])).toBe(false);
    expect(receivableDueOnQuotationFromEntries([], quote, [])).toBe(0);
  });

  it('includes pending balance when production is complete', () => {
    expect(receivableDueOnQuotationFromEntries([], quote, jobs)).toBe(60_000);
  });

  it('returns zero when fully paid after production', () => {
    const paid = { ...quote, paidNgn: 100_000 };
    expect(receivableDueOnQuotationFromEntries([], paid, jobs)).toBe(0);
  });
});
