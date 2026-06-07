import { describe, it, expect } from 'vitest';
import {
  metreVariancePct,
  metreVarianceExceedsThreshold,
  PRODUCTION_METRE_VARIANCE_WARN_PCT,
} from './productionMetreVariance.js';

describe('productionMetreVariance', () => {
  it('returns null when planned is zero', () => {
    expect(metreVariancePct(0, 10)).toBeNull();
  });

  it('computes signed variance', () => {
    expect(metreVariancePct(100, 95)).toBe(-5);
    expect(metreVariancePct(100, 106)).toBe(6);
  });

  it('flags variance beyond threshold', () => {
    expect(metreVarianceExceedsThreshold(100, 94, PRODUCTION_METRE_VARIANCE_WARN_PCT)).toBe(true);
    expect(metreVarianceExceedsThreshold(100, 96, PRODUCTION_METRE_VARIANCE_WARN_PCT)).toBe(false);
    expect(metreVarianceExceedsThreshold(100, 106, PRODUCTION_METRE_VARIANCE_WARN_PCT)).toBe(true);
  });
});
