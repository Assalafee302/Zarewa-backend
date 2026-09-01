import { describe, it, expect } from 'vitest';
import {
  buildRefundCategorySuggestedMaxNgn,
  quotationActualCashInNgn,
  quotationIndependentRefundLinesSumNgn,
  quotationOverpaymentExcessNgn,
  quotationOverpaymentResidualNgn,
  overpaymentAlreadyRefundedNgn,
  quotationRefundHardCapNgn,
  quotationRemainingRefundableNgn,
  validateRefundCalculationLinesNgn,
  validateRefundCategorySuggestedCapsNgn,
  validateRefundSameRequestOverlapCategoriesNgn,
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

  it('does not re-add historical overpayment when only other lines remain after prior refunds', () => {
    // cash 542k, quote 459k → overpay excess 83k; prior refund 98k already cashed
    const lines = [{ category: 'Transport issue', amountNgn: 15_000 }];
    expect(
      quotationRemainingRefundableNgn({
        cashInNgn: 542_000,
        quoteTotalNgn: 459_000,
        totalRefundedNgn: 98_000,
        suggestedLines: lines,
      })
    ).toBe(15_000);
  });

  it('residual overpay with empty lines subtracts prior refunds', () => {
    expect(
      quotationRemainingRefundableNgn({
        cashInNgn: 542_000,
        quoteTotalNgn: 459_000,
        totalRefundedNgn: 50_000,
        suggestedLines: [],
      })
    ).toBe(33_000);
  });

  it('overpayment residual subtracts leftover credit already applied to another quote', () => {
    expect(
      quotationOverpaymentResidualNgn({
        cashInNgn: 4_596_000,
        quoteTotalNgn: 451_764,
        overpaymentAlreadyRefundedNgn: 0,
        creditAppliedOutNgn: 3_200_000,
      })
    ).toBe(944_236);
  });

  it('overpayment residual is zero when prior overpay refunds already cover excess', () => {
    expect(
      quotationOverpaymentResidualNgn({
        cashInNgn: 1_132_400,
        quoteTotalNgn: 981_070,
        overpaymentAlreadyRefundedNgn: 174_830,
      })
    ).toBe(0);
    expect(
      overpaymentAlreadyRefundedNgn(
        [
          {
            refundID: 'RF-9490',
            status: 'Paid',
            amountNgn: 174_830,
            paidAmountNgn: 174_830,
            reasonCategory: 'Overpayment',
          },
          {
            refundID: 'RF-9505',
            status: 'Approved',
            amountNgn: 151_330,
            approvedAmountNgn: 128_300,
            creditAppliedNgn: 23_030,
            reasonCategory: 'Overpayment',
            calculationLines: [{ category: 'Overpayment', amountNgn: 151_330 }],
          },
        ],
        'RF-9505'
      )
    ).toBe(174_830);
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

  it('builds per-category suggested max from preview lines', () => {
    const caps = buildRefundCategorySuggestedMaxNgn([
      { category: 'Overpayment', amountNgn: 50_000 },
      { category: 'Unproduced meterage', amountNgn: 120_000 },
    ]);
    expect(caps.Overpayment).toBe(50_000);
    expect(caps['Unproduced meterage']).toBe(120_000);
  });

  it('rejects manual line above system-calculated category max', () => {
    const caps = buildRefundCategorySuggestedMaxNgn([
      { category: 'Unproduced meterage', amountNgn: 335_820 },
    ]);
    const r = validateRefundCategorySuggestedCapsNgn({
      calculationLines: [{ category: 'Unproduced meterage', amountNgn: 400_000 }],
      categorySuggestedMaxNgn: caps,
    });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/Unproduced meterage/i);
  });

  it('rejects Overpayment and Order cancellation on the same request', () => {
    const r = validateRefundSameRequestOverlapCategoriesNgn([
      { category: 'Overpayment', amountNgn: 10_000 },
      { category: 'Order cancellation', amountNgn: 500_000 },
    ]);
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/double-count/i);
  });

  it('allows Overpayment and Unproduced meterage on the same request when within caps', () => {
    const caps = buildRefundCategorySuggestedMaxNgn([
      { category: 'Overpayment', amountNgn: 1_215_800 },
      { category: 'Unproduced meterage', amountNgn: 335_820 },
    ]);
    const r = validateRefundCalculationLinesNgn({
      cashInNgn: 5_150_000,
      quoteTotalNgn: 3_934_200,
      totalRefundedNgn: 0,
      calculationLines: [
        { category: 'Overpayment', amountNgn: 1_215_800 },
        { category: 'Unproduced meterage', amountNgn: 335_820 },
      ],
      categorySuggestedMaxNgn: caps,
    });
    expect(r.ok).toBe(true);
  });

  it('rejects an overpayment line that exceeds residual after prior overpay refunds', () => {
    const r = validateRefundCalculationLinesNgn({
      cashInNgn: 1_132_400,
      quoteTotalNgn: 981_070,
      totalRefundedNgn: 174_830,
      overpaymentAlreadyRefundedNgn: 174_830,
      calculationLines: [{ category: 'Overpayment', amountNgn: 151_330, include: true }],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cannot exceed/i);
  });

  it('rejects an overpayment line that exceeds residual after leftover credit applied to another quote', () => {
    const r = validateRefundCalculationLinesNgn({
      cashInNgn: 4_596_000,
      quoteTotalNgn: 451_764,
      totalRefundedNgn: 3_200_000,
      creditAppliedOutNgn: 3_200_000,
      calculationLines: [{ category: 'Overpayment', amountNgn: 4_144_236, include: true }],
    });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cannot exceed/i);
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
