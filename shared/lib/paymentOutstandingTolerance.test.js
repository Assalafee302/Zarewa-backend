import { describe, expect, it } from 'vitest';
import {
  effectiveOutstandingNgn,
  isEffectivelyFullyPaid,
  outstandingToleranceNgn,
} from './paymentOutstandingTolerance.js';

describe('paymentOutstandingTolerance', () => {
  it('treats residual below 0.01% as zero outstanding', () => {
    const total = 10_000_000;
    const tol = outstandingToleranceNgn(total);
    expect(tol).toBe(1000);
    expect(effectiveOutstandingNgn(total, total - 500)).toBe(0);
    expect(effectiveOutstandingNgn(total, total - 1001)).toBe(1001);
  });

  it('marks effectively fully paid when within tolerance', () => {
    expect(isEffectivelyFullyPaid(999_999, 1_000_000)).toBe(true);
    expect(isEffectivelyFullyPaid(998_000, 1_000_000)).toBe(false);
  });
});
