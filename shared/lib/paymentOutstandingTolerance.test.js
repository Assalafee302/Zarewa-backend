import { describe, expect, it } from 'vitest';
import {
  effectiveOutstandingNgn,
  isEffectivelyFullyPaid,
  outstandingToleranceNgn,
  PAYMENT_EFFECTIVELY_FULL_FRACTION,
} from './paymentOutstandingTolerance.js';

describe('paymentOutstandingTolerance', () => {
  it('uses 99.5% as the effectively-full threshold', () => {
    expect(PAYMENT_EFFECTIVELY_FULL_FRACTION).toBe(0.995);
  });

  it('treats residual up to 0.5% as zero outstanding', () => {
    const total = 10_000_000;
    const tol = outstandingToleranceNgn(total);
    expect(tol).toBe(50_000);
    expect(effectiveOutstandingNgn(total, total - 50_000)).toBe(0);
    expect(effectiveOutstandingNgn(total, total - 50_001)).toBe(50_001);
  });

  it('marks effectively fully paid at 99.5% or above', () => {
    expect(isEffectivelyFullyPaid(995_000, 1_000_000)).toBe(true);
    expect(isEffectivelyFullyPaid(994_999, 1_000_000)).toBe(false);
    expect(isEffectivelyFullyPaid(1_000_000, 1_000_000)).toBe(true);
  });
});
