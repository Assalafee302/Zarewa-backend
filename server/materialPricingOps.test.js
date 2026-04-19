import { describe, expect, it } from 'vitest';
import {
  averageOfThreeConversions,
  suggestedPricePerMeterNgn,
  theoreticalStandardKgPerM,
} from './materialPricingOps.js';

describe('materialPricingOps', () => {
  it('averages only positive finite inputs', () => {
    expect(averageOfThreeConversions(1, 2, 3)).toBe(2);
    expect(averageOfThreeConversions(1, null, 3)).toBe(2);
    expect(averageOfThreeConversions(null, null, null)).toBe(null);
  });

  it('suggested = conv * cost/kg + overhead + profit', () => {
    expect(suggestedPricePerMeterNgn(2, 500, 100, 50)).toBe(1150);
    expect(suggestedPricePerMeterNgn(null, 500, 0, 0)).toBe(null);
  });

  it('theoretical strip mass for alu gauge', () => {
    const v = theoreticalStandardKgPerM('alu', 0.45);
    expect(v).toBeGreaterThan(1.4);
    expect(v).toBeLessThan(1.6);
  });
});
