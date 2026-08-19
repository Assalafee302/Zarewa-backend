import { describe, it, expect } from 'vitest';
import {
  REFUND_CREDIT_CONFIRMATION_STATUS,
  allocateRefundCreditAcrossSources,
  planCashierRefundOffset,
  planRefundCreditApplyAmount,
  refundCategoriesAreOverpaymentOnly,
  refundCreditOpenAmountNgn,
  refundIsEligibleCreditSource,
  refundLeftoverAwaitingApprovalNgn,
} from './refundCreditApply.js';

describe('refundCreditApply pure helpers', () => {
  it('treats overpayment-only categories correctly', () => {
    expect(refundCategoriesAreOverpaymentOnly('Overpayment', [])).toBe(true);
    expect(refundCategoriesAreOverpaymentOnly(['Overpayment'], [])).toBe(true);
    expect(refundCategoriesAreOverpaymentOnly(['Unproduced meterage'], [])).toBe(false);
    expect(
      refundCategoriesAreOverpaymentOnly('Other', [{ category: 'Overpayment', amountNgn: 1 }])
    ).toBe(false);
    expect(
      refundCategoriesAreOverpaymentOnly('', [{ category: 'Overpayment', amountNgn: 1 }])
    ).toBe(true);
  });

  it('allows Pending overpayment refunds but not Pending other categories', () => {
    expect(
      refundIsEligibleCreditSource({
        status: 'Pending',
        reasonCategory: 'Overpayment',
        amountNgn: 50_000,
        paidAmountNgn: 0,
      })
    ).toBe(true);
    expect(
      refundIsEligibleCreditSource({
        status: 'Pending',
        reasonCategory: 'Unproduced meterage',
        amountNgn: 50_000,
        paidAmountNgn: 0,
      })
    ).toBe(false);
    expect(
      refundIsEligibleCreditSource({
        status: 'Approved',
        reasonCategory: 'Unproduced meterage',
        approvedAmountNgn: 40_000,
        paidAmountNgn: 10_000,
      })
    ).toBe(true);
  });

  it('computes open credit and plans partial apply leaving remainder', () => {
    expect(
      refundCreditOpenAmountNgn({
        status: 'Approved',
        approvedAmountNgn: 120_000,
        paidAmountNgn: 20_000,
        reasonCategory: 'Overpayment',
      })
    ).toBe(100_000);

    const plan = planRefundCreditApplyAmount({
      targetDueNgn: 80_000,
      availableNgn: 120_000,
      requestedNgn: null,
    });
    expect(plan.applyNgn).toBe(80_000);
    expect(plan.remainderDueNgn).toBe(0);
    expect(plan.leftoverCreditNgn).toBe(40_000);

    expect(
      refundCreditOpenAmountNgn({
        status: 'Pending',
        reasonCategory: 'Overpayment',
        amountNgn: 40_000,
        paidAmountNgn: 0,
        creditAppliedNgn: 30_000,
      })
    ).toBe(10_000);
    expect(
      refundLeftoverAwaitingApprovalNgn({
        amountNgn: 40_000,
        creditAppliedNgn: 30_000,
      })
    ).toBe(10_000);

    const alloc = allocateRefundCreditAcrossSources(
      [
        { id: 'a', availableNgn: 50_000 },
        { id: 'b', availableNgn: 70_000 },
      ],
      80_000
    );
    expect(alloc.appliedNgn).toBe(80_000);
    expect(alloc.allocations).toEqual([
      { id: 'a', amountNgn: 50_000, leftoverOnSourceNgn: 0 },
      { id: 'b', amountNgn: 30_000, leftoverOnSourceNgn: 40_000 },
    ]);
    expect(REFUND_CREDIT_CONFIRMATION_STATUS).toBe('Credit confirmation');
  });

  it('plans cashier receipt offset against refund fund', () => {
    expect(planCashierRefundOffset({ receiptCashNgn: 80_000, availableNgn: 50_000 })).toEqual({
      offsetNgn: 50_000,
      cashToConfirmNgn: 30_000,
      leftoverRefundNgn: 0,
    });
    expect(planCashierRefundOffset({ receiptCashNgn: 20_000, availableNgn: 50_000 }).cashToConfirmNgn).toBe(0);
  });
});
