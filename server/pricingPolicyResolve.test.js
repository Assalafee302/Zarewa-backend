import { describe, expect, it } from 'vitest';
import { roundPublishedPrice, premiumProfilePriceFromBase } from './pricingPolicyResolve.js';

describe('pricingPolicyResolve', () => {
  it('roundPublishedPrice uses ₦50 step below 5000 and ₦100 from 5000', () => {
    expect(roundPublishedPrice(123)).toBe(100);
    expect(roundPublishedPrice(127)).toBe(150);
    expect(roundPublishedPrice(4999)).toBe(5000);
    expect(roundPublishedPrice(5049)).toBe(5000);
    expect(roundPublishedPrice(5050)).toBe(5100);
    expect(roundPublishedPrice(0)).toBe(0);
  });

  it('premiumProfilePriceFromBase applies 3.5% then rounding', () => {
    expect(premiumProfilePriceFromBase(1000)).toBe(roundPublishedPrice(1035));
    expect(premiumProfilePriceFromBase(4800)).toBe(4950);
  });
});
