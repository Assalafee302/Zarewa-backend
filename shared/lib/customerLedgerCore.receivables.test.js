import { describe, expect, it } from 'vitest';
import {
  amountDueOnQuotationFromEntries,
  accountingReceivableOutstandingNgn,
  quotationHasCompletedProduction,
  receivableDueOnQuotationFromEntries,
} from './customerLedgerCore.js';
import { isEffectivelyFullyPaid } from './paymentOutstandingTolerance.js';

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

  it('shows the real ₦300 residual under the strict ₦1 payment tolerance', () => {
    // PAYMENT_OUTSTANDING_TOLERANCE_NGN is a deliberate absolute ₦1 tolerance (see
    // paymentOutstandingTolerance.test.js), replacing an older 0.5%-of-invoice rule that would
    // have hidden this ₦300 residual as immaterial. It's real money now, not hidden — still
    // waivable by a Branch Manager via the minor-receivable band (receivableWriteOffPolicy.js).
    const roundOff = { id: 'QT-1', totalNgn: 1_250_300, paidNgn: 1_250_000 };
    expect(isEffectivelyFullyPaid(roundOff.paidNgn, roundOff.totalNgn)).toBe(false);
    expect(amountDueOnQuotationFromEntries([], roundOff)).toBe(300);
    expect(receivableDueOnQuotationFromEntries([], roundOff, jobs)).toBe(300);
    expect(accountingReceivableOutstandingNgn(roundOff.totalNgn, roundOff.paidNgn, 0)).toBe(300);
  });

  it('drops receivable after manager balance waiver', () => {
    const waived = {
      id: 'QT-1',
      totalNgn: 1_250_300,
      paidNgn: 1_250_000,
      paymentBalanceWaivedNgn: 300,
    };
    expect(accountingReceivableOutstandingNgn(waived.totalNgn, waived.paidNgn, waived.paymentBalanceWaivedNgn)).toBe(0);
    expect(receivableDueOnQuotationFromEntries([], waived, jobs)).toBe(0);
  });
});
