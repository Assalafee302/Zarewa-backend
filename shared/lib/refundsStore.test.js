import { describe, it, expect } from 'vitest';
import { approvedRefundsAwaitingPayment, isRefundPayable } from './refundsStore.js';

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
});
