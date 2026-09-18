import { describe, expect, it } from 'vitest';
import { quotedAboveFloorCreditNgn } from './refundQuotedAboveFloor.js';

describe('quotedAboveFloorCreditNgn', () => {
  it('credits (quoted ₦/m − floor ₦/m) × metres', () => {
    expect(quotedAboveFloorCreditNgn(5000, 4500, 10)).toBe(5_000);
  });

  it('is zero when sold at or below floor', () => {
    expect(quotedAboveFloorCreditNgn(4500, 4500, 10)).toBe(0);
    expect(quotedAboveFloorCreditNgn(4400, 4500, 10)).toBe(0);
  });

  it('is zero when sold at list with no floor gap is not this helper’s job — list 5000 vs floor 4500 still credits', () => {
    expect(quotedAboveFloorCreditNgn(5000, 4500, 80)).toBe(40_000);
  });

  it('returns 0 for missing inputs', () => {
    expect(quotedAboveFloorCreditNgn(null, 4500, 10)).toBe(0);
    expect(quotedAboveFloorCreditNgn(5000, 0, 10)).toBe(0);
    expect(quotedAboveFloorCreditNgn(5000, 4500, 0)).toBe(0);
  });
});
