import { describe, it, expect } from 'vitest';
import {
  refundOverpayConsumedNgn,
  refundOverpayFinishedPayout,
  refundOverpaymentLineNgn,
  unclaimedOverpayCreditNgn,
} from './refundCreditApply.js';

describe('refundOverpayConsumedNgn — mixed refunds (RF-KD-26-9734, QT-KD-26-1697)', () => {
  const mixedLines = [
    { category: 'Overpayment', amountNgn: 47_450 },
    { category: 'Installation', amountNgn: 15_000 },
    { category: 'Transport', amountNgn: 12_000 },
  ];
  const mixed = (over = {}) => ({
    status: 'Paid',
    reasonCategory: '["Overpayment","Installation","Transport"]',
    calculationLines: mixedLines,
    amountNgn: 74_450,
    paidAmountNgn: 72_000,
    paidAtISO: '2026-10-02',
    paidBy: 'Cashier',
    ...over,
  });

  it('paid mixed refund consumes its Overpayment line', () => {
    expect(refundOverpaymentLineNgn(mixedLines)).toBe(47_450);
    expect(refundOverpayConsumedNgn(mixed(), 72_000)).toBe(47_450);
    expect(refundOverpayFinishedPayout(mixed(), 72_000)).toBe(true);
    // The overpayment is no longer offered as credit.
    expect(
      unclaimedOverpayCreditNgn({
        economicExcessNgn: 47_450,
        refundConsumedNgn: refundOverpayConsumedNgn(mixed(), 72_000),
      })
    ).toBe(0);
  });

  it('partly paid mixed refund consumes no more than was paid out', () => {
    expect(refundOverpayConsumedNgn(mixed({ status: 'Partially paid', paidAmountNgn: 30_000 }), 30_000)).toBe(30_000);
  });

  it('pending mixed refund consumes nothing', () => {
    expect(
      refundOverpayConsumedNgn(
        mixed({ status: 'Pending', paidAmountNgn: 0, paidAtISO: '', paidBy: '' }),
        0
      )
    ).toBe(0);
  });

  it('approved mixed refund with approval-only paid amount (no payout record) consumes nothing', () => {
    expect(refundOverpayConsumedNgn(mixed({ status: 'Approved', paidAtISO: '', paidBy: '' }), 0)).toBe(0);
  });

  it('cancelled / rejected mixed refund consumes nothing', () => {
    expect(refundOverpayConsumedNgn(mixed({ status: 'Cancelled' }), 72_000)).toBe(0);
    expect(refundOverpayConsumedNgn(mixed({ status: 'Rejected' }), 72_000)).toBe(0);
  });

  it('refund with no Overpayment line consumes nothing', () => {
    expect(
      refundOverpayConsumedNgn(
        mixed({
          reasonCategory: '["Installation","Transport"]',
          calculationLines: mixedLines.slice(1),
          amountNgn: 27_000,
          paidAmountNgn: 27_000,
        }),
        27_000
      )
    ).toBe(0);
  });

  it('overpayment-only refund is unchanged: consumes the payout up to the request', () => {
    const overpayOnly = {
      status: 'Paid',
      reasonCategory: '["Overpayment"]',
      calculationLines: [{ category: 'Overpayment', amountNgn: 47_450 }],
      amountNgn: 47_450,
      paidAmountNgn: 47_450,
      paidAtISO: '2026-10-02',
      paidBy: 'Cashier',
    };
    expect(refundOverpayConsumedNgn(overpayOnly, 47_450)).toBe(47_450);
    expect(refundOverpayConsumedNgn({ ...overpayOnly, status: 'Pending', paidAmountNgn: 0, paidAtISO: '', paidBy: '' }, 0)).toBe(0);
  });
});
