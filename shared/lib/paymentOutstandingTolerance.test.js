import { describe, expect, it } from 'vitest';
import {
  effectiveOutstandingNgn,
  isEffectivelyFullyPaid,
  outstandingToleranceNgn,
  PAYMENT_OUTSTANDING_TOLERANCE_NGN,
} from './paymentOutstandingTolerance.js';

describe('paymentOutstandingTolerance', () => {
  it('uses a ₦1 absolute residual, not a percent of the invoice', () => {
    expect(PAYMENT_OUTSTANDING_TOLERANCE_NGN).toBe(1);
    expect(outstandingToleranceNgn(10_000_000)).toBe(1);
  });

  it('treats residual up to ₦1 as zero outstanding', () => {
    const total = 10_000_000;
    expect(effectiveOutstandingNgn(total, total - 1)).toBe(0);
    expect(effectiveOutstandingNgn(total, total - 2)).toBe(2);
  });

  it('marks effectively fully paid within absolute tolerance', () => {
    expect(isEffectivelyFullyPaid(999_999, 1_000_000)).toBe(true);
    expect(isEffectivelyFullyPaid(999_998, 1_000_000)).toBe(false);
    expect(isEffectivelyFullyPaid(1_000_000, 1_000_000)).toBe(true);
  });
});
