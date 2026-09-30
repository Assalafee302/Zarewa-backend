import { describe, expect, it } from 'vitest';
import {
  conversionVariancePct,
  formatConversionVariancePct,
  roundConv2,
} from './conversionKgPerM.js';

describe('conversionVariancePct', () => {
  it('returns signed % of actual vs reference kg/m', () => {
    expect(conversionVariancePct(4.62, 4.2)).toBeCloseTo(10, 5);
    expect(conversionVariancePct(3.78, 4.2)).toBeCloseTo(-10, 5);
  });

  it('returns null when either side is missing', () => {
    expect(conversionVariancePct(null, 4.2)).toBeNull();
    expect(conversionVariancePct(4.2, 0)).toBeNull();
  });
});

describe('formatConversionVariancePct', () => {
  it('formats high and low with a sign', () => {
    expect(formatConversionVariancePct(14.76)).toBe('+14.8%');
    expect(formatConversionVariancePct(-9.04)).toBe('−9.0%');
    expect(formatConversionVariancePct(0)).toBe('0.0%');
  });
});

describe('roundConv2', () => {
  it('keeps kg/m to two decimals', () => {
    expect(roundConv2(4.226)).toBe(4.23);
  });
});
