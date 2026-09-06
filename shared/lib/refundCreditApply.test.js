import { describe, it, expect } from 'vitest';
import {
  REFUND_CREDIT_CONFIRMATION_STATUS,
  allocateRefundCreditAcrossSources,
  planCashierRefundOffset,
  planRefundCreditApplyAmount,
  isQuotationActiveRefundLockError,
  refundBlocksExternalCreditOnQuotation,
  refundCategoriesAreOverpaymentOnly,
  refundCreditOpenAmountFromStoredRefund,
  refundCreditOpenAmountNgn,
  refundCreditUnavailableReason,
  refundIsEligibleCreditSource,
  refundIsEligibleCreditSourceKind,
  refundLeftoverAwaitingApprovalNgn,
  refundOverpayConsumedNgn,
  refundOverpayFinishedPayout,
  refundFundRemainingHowToUse,
  refundFundUsageBreakdown,
  refundSplitHasMultiplePayees,
  refundSplitPayeeKeys,
  stripFinishedOverpayFromConfirmEligible,
  unclaimedOverpayCreditNgn,
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

  it('counts distinct payees on a refund split by recipient id, ignoring zero-amount lines', () => {
    expect(
      refundSplitPayeeKeys([
        { recipientKind: 'customer', recipientCustomerID: 'CUS-1', amountNgn: 75_000 },
        { recipientKind: 'associated_staff', recipientAssociatedStaffID: 'AST-1', amountNgn: 14_300 },
      ])
    ).toHaveLength(2);
    expect(
      refundSplitPayeeKeys([{ recipientKind: 'customer', recipientCustomerID: 'CUS-1', amountNgn: 75_000 }])
    ).toHaveLength(1);
    expect(refundSplitPayeeKeys([])).toHaveLength(0);
    // A zero-amount line (e.g. fully consumed already) does not count as a second payee.
    expect(
      refundSplitPayeeKeys([
        { recipientKind: 'customer', recipientCustomerID: 'CUS-1', amountNgn: 75_000 },
        { recipientKind: 'associated_staff', recipientAssociatedStaffID: 'AST-1', amountNgn: 0 },
      ])
    ).toHaveLength(1);
  });

  it('blocks a multi-payee split refund (staff + customer) from being used as receipt credit', () => {
    const multiPayeeRefund = {
      status: 'Approved',
      reasonCategory: 'Order cancellation',
      approvedAmountNgn: 89_300,
      paidAmountNgn: 0,
      splitDistributions: [
        { recipientKind: 'customer', recipientCustomerID: 'CUS-1', amountNgn: 75_000 },
        { recipientKind: 'associated_staff', recipientAssociatedStaffID: 'AST-1', amountNgn: 14_300 },
      ],
    };
    expect(refundSplitHasMultiplePayees(multiPayeeRefund.splitDistributions)).toBe(true);
    expect(refundIsEligibleCreditSourceKind(multiPayeeRefund)).toBe(false);
    expect(refundIsEligibleCreditSource(multiPayeeRefund)).toBe(false);
    expect(refundCreditUnavailableReason(multiPayeeRefund, 50_000)).toMatch(/more than one person/i);
  });

  it('still allows a single-payee split refund as receipt credit', () => {
    const singlePayeeRefund = {
      status: 'Approved',
      reasonCategory: 'Order cancellation',
      approvedAmountNgn: 14_300,
      paidAmountNgn: 0,
      splitDistributions: [
        { recipientKind: 'associated_staff', recipientAssociatedStaffID: 'AST-1', amountNgn: 14_300 },
      ],
    };
    expect(refundSplitHasMultiplePayees(singlePayeeRefund.splitDistributions)).toBe(false);
    expect(refundIsEligibleCreditSourceKind(singlePayeeRefund)).toBe(true);
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

  it('pools economic overpay as credit even when no refund was requested', () => {
    expect(
      unclaimedOverpayCreditNgn({
        ledgerPoolNgn: 0,
        economicExcessNgn: 61_200,
        refundOpenNgn: 0,
        creditAppliedOutNgn: 0,
      })
    ).toBe(61_200);
    expect(
      unclaimedOverpayCreditNgn({
        ledgerPoolNgn: 61_200,
        economicExcessNgn: 61_200,
        refundOpenNgn: 61_200,
        creditAppliedOutNgn: 0,
      })
    ).toBe(0);
    expect(
      unclaimedOverpayCreditNgn({
        ledgerPoolNgn: 0,
        economicExcessNgn: 61_200,
        refundOpenNgn: 0,
        creditAppliedOutNgn: 20_000,
      })
    ).toBe(41_200);
    expect(
      unclaimedOverpayCreditNgn({
        ledgerPoolNgn: 0,
        economicExcessNgn: 771_500,
        refundOpenNgn: 0,
        refundConsumedNgn: 771_500,
      })
    ).toBe(0);
  });

  it('treats till-paid overpayment as consumed and ignores false Paid with no payout date', () => {
    expect(
      refundOverpayConsumedNgn({
        status: 'Approved',
        reasonCategory: '["Overpayment"]',
        amountNgn: 771_500,
        paidAmountNgn: 771_500,
        paidAtISO: '2026-08-08',
        paidBy: 'Zarewa Admin',
        creditAppliedNgn: 0,
      })
    ).toBe(771_500);
    expect(
      refundOverpayConsumedNgn({
        status: 'Paid',
        reasonCategory: '["Overpayment"]',
        amountNgn: 61_200,
        paidAmountNgn: 61_200,
        paidAtISO: '',
        paidBy: '',
        creditAppliedNgn: 0,
      })
    ).toBe(0);
    expect(
      refundOverpayConsumedNgn(
        {
          status: 'Approved',
          reasonCategory: '["Overpayment"]',
          amountNgn: 771_500,
          paidAmountNgn: 0,
          paidAtISO: '',
          paidBy: '',
        },
        771_500
      )
    ).toBe(771_500);
    expect(
      refundOverpayFinishedPayout({
        status: 'Approved',
        reasonCategory: '["Overpayment"]',
        amountNgn: 771_500,
        paidAmountNgn: 771_500,
        paidAtISO: '2026-08-08',
        paidBy: 'Zarewa Admin',
      })
    ).toBe(true);
    expect(
      stripFinishedOverpayFromConfirmEligible({
        unavailableSources: [
          {
            refundId: 'RF-KD-26-9456',
            availableNgn: 0,
            status: 'Approved',
            reasonCategory: '["Overpayment"]',
            amountNgn: 771_500,
            paidAmountNgn: 771_500,
            paidAtISO: '2026-08-08',
            paidBy: 'Zarewa Admin',
          },
          {
            refundId: 'RF-KD-26-9553',
            availableNgn: 0,
            status: 'Paid',
            reasonCategory: '["Overpayment"]',
            amountNgn: 61_200,
            paidAmountNgn: 61_200,
            paidAtISO: '',
            paidBy: '',
          },
        ],
      }).unavailableSources.map((s) => s.refundId)
    ).toEqual(['RF-KD-26-9553']);
  });

  it('explains already-used refund fund vs leftover', () => {
    expect(
      refundFundRemainingHowToUse({
        amountNgn: 151_330,
        availableNgn: 128_300,
        creditAppliedNgn: 23_030,
        creditAppliedToQuotationRef: 'QT-KD-26-1282',
      })
    ).toMatch(/Already used ₦23,030 on QT-KD-26-1282/);
    expect(
      refundFundRemainingHowToUse({
        amountNgn: 151_330,
        availableNgn: 128_300,
        creditAppliedNgn: 23_030,
        creditAppliedToQuotationRef: 'QT-KD-26-1282',
      })
    ).toMatch(/₦128,300 left/);
    expect(
      refundFundUsageBreakdown({
        amountNgn: 50_000,
        creditAppliedNgn: 20_000,
        availableNgn: 0,
      }).leftNgn
    ).toBe(0);
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

  it('detects quotation open-refund lock errors so finance confirm can skip credit', () => {
    expect(
      isQuotationActiveRefundLockError(
        'Quotation QT-1 has an active refund request (RF-1) and cannot receive credit from another job.'
      )
    ).toBe(true);
    expect(
      isQuotationActiveRefundLockError(
        'Quotation QT-1 has an active refund request (RF-1). Confirm existing receipts in Finance, then pay or finish that refund. New cash cannot be posted on this job until then.'
      )
    ).toBe(true);
    expect(isQuotationActiveRefundLockError('Treasury lines must equal the receipt amount.')).toBe(false);
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
