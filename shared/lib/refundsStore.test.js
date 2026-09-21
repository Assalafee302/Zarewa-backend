import { describe, it, expect } from 'vitest';
import {
  approvedRefundsAwaitingPayment,
  applyRefundSplitRemainingTillPayable,
  isRefundPayable,
  refundOutstandingAmount,
} from './refundsStore.js';

describe('refundsStore payable filters', () => {
  const payable = {
    refundID: 'RF-1',
    status: 'Approved',
    amountNgn: 5000,
    approvedAmountNgn: 5000,
    paidAmountNgn: 0,
    quotationRefundsBlockedAtISO: null,
  };

  const blocked = {
    ...payable,
    refundID: 'RF-2',
    quotationRefundsBlockedAtISO: '2026-06-01T10:00:00.000Z',
    quotationRefundsBlockedReason: 'Mistaken overpayment',
  };

  it('treats approved outstanding refunds as payable when quotation is not blocked', () => {
    expect(isRefundPayable(payable)).toBe(true);
    expect(approvedRefundsAwaitingPayment([payable, blocked])).toEqual([payable]);
  });

  it('excludes permanently blocked quotations from payable queues', () => {
    expect(isRefundPayable(blocked)).toBe(false);
    expect(approvedRefundsAwaitingPayment([blocked])).toEqual([]);
  });

  it('drops from Pay when approved fund was applied onto another receipt', () => {
    const applied = {
      ...payable,
      paidAmountNgn: 5000,
      creditAppliedNgn: 5000,
      creditAppliedToQuotationRef: 'QT-NEW',
    };
    expect(isRefundPayable(applied)).toBe(false);
    expect(approvedRefundsAwaitingPayment([applied])).toEqual([]);
  });

  it('reduces outstanding after a partial credit apply', () => {
    const partial = {
      ...payable,
      paidAmountNgn: 2000,
      creditAppliedNgn: 2000,
    };
    expect(isRefundPayable(partial)).toBe(true);
    expect(approvedRefundsAwaitingPayment([partial])).toEqual([partial]);
  });

  it('drops from Pay when settlement till payable is already zero', () => {
    const settledOnTill = {
      ...payable,
      paidAmountNgn: 3500,
      creditAppliedNgn: 3500,
      companyCutNgn: 1500,
      settlementSummary: { tillPayableNgn: 0, cashOutstandingNgn: 0, companyCutNgn: 1500 },
    };
    expect(isRefundPayable(settledOnTill)).toBe(false);
  });

  it('drops from Pay even if a stale settlement summary still shows the old till due', () => {
    const stale = {
      ...payable,
      paidAmountNgn: 5000,
      creditAppliedNgn: 5000,
      settlementSummary: { tillPayableNgn: 5000, cashOutstandingNgn: 5000 },
    };
    expect(isRefundPayable(stale)).toBe(false);
  });

  it('shrinks staff netPayout to till leftover after credit apply (RF-9636 class)', () => {
    const splits = [
      {
        recipientKind: 'customer',
        recipientCustomerID: 'CUS-STAFF',
        amountNgn: 959_380,
        netPayoutNgn: 959_380,
      },
    ];
    const next = applyRefundSplitRemainingTillPayable(splits, 751_480);
    expect(next[0].netPayoutNgn).toBe(751_480);
    expect(next[0].originalNetPayoutNgn).toBe(959_380);
    expect(
      refundOutstandingAmount({
        amountNgn: 959_380,
        approvedAmountNgn: 959_380,
        paidAmountNgn: 207_900,
        creditAppliedNgn: 207_900,
        settlementSummary: { tillPayableNgn: 751_480, cashOutstandingNgn: 751_480 },
      })
    ).toBe(751_480);
  });
});
