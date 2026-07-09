import { describe, expect, it } from 'vitest';
import {
  buildDerivedRefundCategoryCapsNgn,
  mergeRefundCategoryCapsNgn,
} from './refundCategoryDerivedCaps.js';
import { validateRefundCategorySuggestedCapsNgn } from './refundQuotationMoney.js';

describe('refundCategoryDerivedCaps', () => {
  it('caps Order cancellation and Other at economic floor when production exists', () => {
    const caps = buildDerivedRefundCategoryCapsNgn({
      cashInNgn: 1_000_000,
      totalRefundedNgn: 0,
      economicFloor: {
        producedOutputMeters: 80,
        floorDeliveredValueNgn: 600_000,
        maxDefensibleRefundNgn: 400_000,
      },
    });
    expect(caps['Order cancellation']).toBe(400_000);
    expect(caps.Other).toBe(400_000);
  });

  it('allows full hard cap for cancellation when nothing produced', () => {
    const caps = buildDerivedRefundCategoryCapsNgn({
      cashInNgn: 1_000_000,
      totalRefundedNgn: 200_000,
      economicFloor: {
        producedOutputMeters: 0,
        floorDeliveredValueNgn: 0,
        maxDefensibleRefundNgn: 800_000,
      },
    });
    expect(caps['Order cancellation']).toBe(800_000);
  });

  it('merge tightens preview caps with derived ceilings', () => {
    const merged = mergeRefundCategoryCapsNgn(
      { Other: 900_000 },
      { Other: 400_000, 'Order cancellation': 400_000 }
    );
    expect(merged.Other).toBe(400_000);
    expect(merged['Order cancellation']).toBe(400_000);
  });

  it('enforces derived cap on Other when preview had no suggestion', () => {
    const derived = { Other: 300_000 };
    const check = validateRefundCategorySuggestedCapsNgn({
      calculationLines: [{ category: 'Other', amountNgn: 500_000, include: true }],
      categorySuggestedMaxNgn: {},
      derivedCategoryMaxNgn: derived,
    });
    expect(check.ok).toBe(false);
    expect(check.category).toBe('Other');
  });
});
