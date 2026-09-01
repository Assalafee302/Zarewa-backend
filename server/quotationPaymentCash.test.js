import { describe, it, expect } from 'vitest';
import { quotationPaymentCashBreakdownFromRows } from './quotationPaymentCash.js';

describe('quotationPaymentCashBreakdownFromRows', () => {
  it('does not treat leftover CREDIT_APPLY reversals as less cash on the source quote', () => {
    const cash = quotationPaymentCashBreakdownFromRows(
      [{ id: 'RCT-1', amount_ngn: 172_800, status: 'Confirmed' }],
      [
        {
          type: 'OVERPAY_ADVANCE',
          amountNgn: 287_200,
          bankReference: 'SPLIT-1',
        },
        {
          type: 'OVERPAY_REVERSAL',
          amountNgn: 100_000,
          bankReference: 'CREDIT_APPLY:RCA-OVR-1',
        },
      ]
    );
    expect(cash.netOverpayLedgerNgn).toBe(287_200);
    expect(cash.cashInNgn).toBe(460_000);
  });

  it('still nets ordinary overpay reversals that are not leftover credit moves', () => {
    const cash = quotationPaymentCashBreakdownFromRows(
      [{ id: 'RCT-1', amount_ngn: 172_800, status: 'Confirmed' }],
      [
        {
          type: 'OVERPAY_ADVANCE',
          amountNgn: 287_200,
          bankReference: 'SPLIT-1',
        },
        {
          type: 'OVERPAY_REVERSAL',
          amountNgn: 50_000,
          bankReference: 'CORR-1',
        },
      ]
    );
    expect(cash.netOverpayLedgerNgn).toBe(237_200);
    expect(cash.cashInNgn).toBe(410_000);
  });
});
