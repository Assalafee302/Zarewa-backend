import { describe, expect, it } from 'vitest';
import {
  cuttingListPaymentThresholdTotalNgn,
  meetsCuttingListPaymentGate,
  nextPaymentGateBasisTotalNgn,
  paymentGateBasisAfterQuotationTotalIncrease,
} from './cuttingListPaymentGate.js';

describe('cuttingListPaymentGate', () => {
  it('honors payment basis when list publish raises total after gate was met', () => {
    const q = {
      total_ngn: 5500,
      paid_ngn: 3500,
      payment_gate_basis_total_ngn: 5000,
    };
    expect(meetsCuttingListPaymentGate(q, 3500, 0.7, false)).toBe(true);
    expect(meetsCuttingListPaymentGate(q, 3500, 0.7, true)).toBe(false);
  });

  it('uses live total when below-floor discount is pending', () => {
    expect(cuttingListPaymentThresholdTotalNgn(5500, 5000, true)).toBe(5500);
    expect(cuttingListPaymentThresholdTotalNgn(5500, 5000, false)).toBe(5000);
  });

  it('nextPaymentGateBasisTotalNgn snaps when paid crosses threshold', () => {
    expect(nextPaymentGateBasisTotalNgn(3500, 5000, 0, 0.7)).toBe(5000);
    expect(nextPaymentGateBasisTotalNgn(3400, 5000, 0, 0.7)).toBeNull();
  });

  it('paymentGateBasisAfterQuotationTotalIncrease preserves satisfied gate', () => {
    expect(paymentGateBasisAfterQuotationTotalIncrease(5000, 5500, 3500, 0, 0.7)).toBe(5000);
    expect(paymentGateBasisAfterQuotationTotalIncrease(5000, 5500, 3000, 0, 0.7)).toBeNull();
  });
});
