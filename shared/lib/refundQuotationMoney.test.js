import { describe, it, expect } from 'vitest';
import {
  quotationOverpaymentExcessNgn,
  quotationRefundHeadroomNgn,
} from './refundQuotationMoney.js';

describe('refundQuotationMoney', () => {
  it('overpayment excess is cash in minus quote total', () => {
    expect(
      quotationOverpaymentExcessNgn({ cashInNgn: 460_000, quoteTotalNgn: 172_800 })
    ).toBe(287_200);
    expect(
      quotationOverpaymentExcessNgn({ cashInNgn: 172_800, quoteTotalNgn: 172_800 })
    ).toBe(0);
  });

  it('refund headroom when overpaid is cash in minus quote total minus refunds', () => {
    expect(
      quotationRefundHeadroomNgn({
        cashInNgn: 460_000,
        quoteTotalNgn: 172_800,
        totalRefundedNgn: 0,
      })
    ).toBe(287_200);
    expect(
      quotationRefundHeadroomNgn({
        cashInNgn: 460_000,
        quoteTotalNgn: 172_800,
        totalRefundedNgn: 50_000,
      })
    ).toBe(237_200);
  });

  it('refund headroom when not overpaid is cash in minus refunds', () => {
    expect(
      quotationRefundHeadroomNgn({
        cashInNgn: 172_800,
        quoteTotalNgn: 172_800,
        totalRefundedNgn: 0,
      })
    ).toBe(172_800);
    expect(
      quotationRefundHeadroomNgn({
        cashInNgn: 100_000,
        quoteTotalNgn: 172_800,
        totalRefundedNgn: 0,
      })
    ).toBe(100_000);
  });
});
