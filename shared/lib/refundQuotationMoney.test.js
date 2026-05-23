import { describe, it, expect } from 'vitest';
import {
  quotationActualCashInNgn,
  quotationIndependentRefundLinesSumNgn,
  quotationOverpaymentExcessNgn,
  quotationRefundHardCapNgn,
  quotationRemainingRefundableNgn,
  validateRefundCalculationLinesNgn,
} from './refundQuotationMoney.js';

describe('refundQuotationMoney', () => {
  it('overpayment excess is cash in minus quote total', () => {
    expect(
      quotationOverpaymentExcessNgn({ cashInNgn: 5_150_000, quoteTotalNgn: 3_934_200 })
    ).toBe(1_215_800);
  });

  it('remaining refundable adds overpayment and independent category lines', () => {
    const lines = [
      { category: 'Overpayment', amountNgn: 1_215_800 },
      { category: 'Unproduced meterage', amountNgn: 335_820 },
    ];
    expect(quotationRemainingRefundableNgn({
      cashInNgn: 5_150_000,
      quoteTotalNgn: 3_934_200,
      totalRefundedNgn: 0,
      suggestedLines: lines,
    })).toBe(1_551_620);
  });

  it('hard cap limits total when overpay excess plus independent lines exceed cash received', () => {
    const lines = [
      { category: 'Overpayment', amountNgn: 400_000 },
      { category: 'Unproduced meterage', amountNgn: 900_000 },
    ];
    expect(quotationRemainingRefundableNgn({
      cashInNgn: 1_200_000,
      quoteTotalNgn: 800_000,
      totalRefundedNgn: 0,
      suggestedLines: lines,
    })).toBe(1_200_000);
  });

  it('remaining is sum of lines when below hard cap', () => {
    const lines = [
      { category: 'Overpayment', amountNgn: 400_000 },
      { category: 'Unproduced meterage', amountNgn: 500_000 },
    ];
    expect(quotationRemainingRefundableNgn({
      cashInNgn: 1_200_000,
      quoteTotalNgn: 800_000,
      totalRefundedNgn: 0,
      suggestedLines: lines,
    })).toBe(900_000);
  });

  it('validates overpayment line cannot exceed payment minus quote', () => {
    const r = validateRefundCalculationLinesNgn({
      cashInNgn: 5_150_000,
      quoteTotalNgn: 3_934_200,
      totalRefundedNgn: 0,
      calculationLines: [
        { category: 'Overpayment', amountNgn: 1_300_000 },
        { category: 'Unproduced meterage', amountNgn: 100_000 },
      ],
    });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/Overpayment/i);
  });

  it('full receipt on quote counts all cash for refund cap (no split companion)', () => {
    const cashIn = quotationActualCashInNgn({
      receiptCashNgn: 650_000,
      advanceAppliedNgn: 0,
      netOverpayLedgerNgn: 0,
      companionOverpayOnQuoteNgn: 0,
      settledQuoteFullOverpayNgn: 0,
    });
    expect(cashIn).toBe(650_000);
    expect(
      quotationOverpaymentExcessNgn({ cashInNgn: cashIn, quoteTotalNgn: 620_000 })
    ).toBe(30_000);
  });

  it('dedupes settled-quote repeat overpay when receipt cash is already on file', () => {
    const cashIn = quotationActualCashInNgn({
      receiptCashNgn: 580_400,
      advanceAppliedNgn: 0,
      netOverpayLedgerNgn: 596_260,
      companionOverpayOnQuoteNgn: 15_860,
      settledQuoteFullOverpayNgn: 580_400,
    });
    expect(cashIn).toBe(580_400);
    expect(
      quotationRefundHardCapNgn({ cashInNgn: cashIn, totalRefundedNgn: 0 })
    ).toBe(580_400);
    expect(quotationIndependentRefundLinesSumNgn([])).toBe(0);
  });
});
