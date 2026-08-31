import { describe, it, expect } from 'vitest';
import {
  REFUND_CREDIT_CONFIRMATION_STATUS,
  REFUND_OVERPAYMENT_STAFF_ALLOCATION_ERROR,
  allocateRefundCreditAcrossSources,
  planCashierRefundOffset,
  planRefundCreditApplyAmount,
  refundBlocksExternalCreditOnQuotation,
  refundCategoriesAreOverpaymentOnly,
  refundCreditOpenAmountFromStoredRefund,
  refundCreditOpenAmountNgn,
  refundIsEligibleCreditSource,
  refundLeftoverAwaitingApprovalNgn,
  refundOverpaymentStaffAllocationError,
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

  it('blocks overpayment allocated to associated staff or claiming staff', () => {
    expect(
      refundOverpaymentStaffAllocationError({
        reasonCategory: ['Overpayment'],
        calculationLines: [{ category: 'Overpayment', amountNgn: 10_000 }],
        quoteCustomerId: 'CUS-QUOTE',
        splits: [
          {
            recipientKind: 'associated_staff',
            recipientAssociatedStaffID: 'AST-1',
            amountNgn: 10_000,
          },
        ],
      })
    ).toBe(REFUND_OVERPAYMENT_STAFF_ALLOCATION_ERROR);
    expect(
      refundOverpaymentStaffAllocationError({
        reasonCategory: ['Overpayment'],
        quoteCustomerId: 'CUS-QUOTE',
        splits: [
          { recipientKind: 'customer', recipientCustomerID: 'CUS-CLAIM', amountNgn: 10_000 },
        ],
      })
    ).toBe(REFUND_OVERPAYMENT_STAFF_ALLOCATION_ERROR);
    expect(
      refundOverpaymentStaffAllocationError({
        reasonCategory: ['Overpayment'],
        quoteCustomerId: 'CUS-QUOTE',
        splits: [
          { recipientKind: 'customer', recipientCustomerID: 'CUS-QUOTE', amountNgn: 10_000 },
        ],
      })
    ).toBeNull();
    expect(
      refundOverpaymentStaffAllocationError({
        reasonCategory: ['Transport issue'],
        quoteCustomerId: 'CUS-QUOTE',
        splits: [
          {
            recipientKind: 'associated_staff',
            recipientAssociatedStaffID: 'AST-1',
            amountNgn: 10_000,
          },
        ],
      })
    ).toBeNull();
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
    expect(
      refundIsEligibleCreditSource({
        status: 'Approved',
        reasonCategory: 'Transport issue',
        approvedAmountNgn: 40_000,
        paidAmountNgn: 0,
      })
    ).toBe(false);
    expect(
      refundIsEligibleCreditSource({
        status: 'Approved',
        reasonCategory: 'Installation issue',
        approvedAmountNgn: 25_000,
        paidAmountNgn: 0,
      })
    ).toBe(false);
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

  it('does not cap overpayment-only refund credit at staff split net pool', () => {
    const row = {
      status: 'Pending',
      amount_ngn: 61_200,
      paid_amount_ngn: 34_000,
      credit_applied_ngn: 0,
      reason_category: '["Overpayment"]',
      calculation_lines_json: JSON.stringify([{ category: 'Overpayment', amountNgn: 61_200 }]),
      split_distributions_json: JSON.stringify([
        {
          recipientKind: 'associated_staff',
          recipientAssociatedStaffID: 'AST-1',
          amountNgn: 61_200,
          companyDeductionNgn: 12_240,
          netPayoutNgn: 0,
        },
      ]),
    };
    expect(refundCreditOpenAmountFromStoredRefund(row)).toBe(27_200);
    expect(refundCreditOpenAmountFromStoredRefund({ ...row, paid_amount_ngn: 0 })).toBe(61_200);
  });

  it('caps open credit at net payout when staff company cut is not settled in paid_amount', () => {
    expect(
      refundCreditOpenAmountFromStoredRefund({
        status: 'Approved',
        approved_amount_ngn: 10_000,
        paid_amount_ngn: 0,
        amount_ngn: 10_000,
        reason_category: '["Transport issue"]',
        split_distributions_json: JSON.stringify([
          {
            recipientKind: 'associated_staff',
            recipientAssociatedStaffID: 'AST-1',
            amountNgn: 10_000,
            companyDeductionNgn: 2_000,
            netPayoutNgn: 8_000,
          },
        ]),
      })
    ).toBe(8_000);
  });

  it('does not block external credit when target only has a pending overpay refund', () => {
    expect(
      refundBlocksExternalCreditOnQuotation({
        status: 'Pending',
        reason_category: '["Overpayment"]',
        amount_ngn: 20_000,
        calculation_lines_json: JSON.stringify([{ category: 'Overpayment', amountNgn: 20_000 }]),
      })
    ).toBe(false);
    expect(
      refundBlocksExternalCreditOnQuotation({
        status: 'Pending',
        reason_category: '["Unproduced meterage"]',
        amount_ngn: 15_000,
      })
    ).toBe(true);
  });
});
