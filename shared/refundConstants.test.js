import { describe, it, expect } from 'vitest';
import {
  normalizeRefundReasonCategoriesForApi,
  quotationMeetsRefundPickerFloor,
  REFUND_PREVIEW_VERSION,
  MIN_REFUND_QUOTATION_REMAINING_NGN,
  REFUND_AMOUNT_LINE_TOLERANCE_NGN,
  refundAmountExceedsEconomicFloorCap,
  refundFloorGatedAmountNgn,
} from './refundConstants.js';

describe('refundConstants', () => {
  it('normalizes legacy category labels to canonical values', () => {
    expect(normalizeRefundReasonCategoriesForApi(['Transport refund', 'Accessory refund', 'stone shortfall'])).toEqual([
      'Transport issue',
      'Accessory shortfall',
      'Stone flatsheet shortfall',
    ]);
    expect(normalizeRefundReasonCategoriesForApi('Substitution pricing')).toEqual(['Substitution Difference']);
    expect(normalizeRefundReasonCategoriesForApi('Agent commission')).toEqual(['Customer commission']);
    expect(normalizeRefundReasonCategoriesForApi('Adjustment')).toEqual(['Other']);
    expect(normalizeRefundReasonCategoriesForApi('["Unproduced meterage"]')).toEqual(['Unproduced meterage']);
  });

  it('dedupes categories case-insensitively', () => {
    expect(normalizeRefundReasonCategoriesForApi(['Overpayment', 'overpayment', 'Other'])).toEqual([
      'Overpayment',
      'Other',
    ]);
  });

  it('exposes preview engine version', () => {
    expect(typeof REFUND_PREVIEW_VERSION).toBe('number');
    expect(REFUND_PREVIEW_VERSION).toBeGreaterThan(0);
  });

  it('exposes refund picker remaining floor', () => {
    expect(MIN_REFUND_QUOTATION_REMAINING_NGN).toBe(1000);
  });

  it('quotationMeetsRefundPickerFloor requires categories, remaining, and preview total', () => {
    expect(
      quotationMeetsRefundPickerFloor({
        eligible_refund_categories: ['Overpayment'],
        remaining_ngn: 5000,
        suggested_preview_amount_ngn: 2500,
      })
    ).toBe(true);
    expect(
      quotationMeetsRefundPickerFloor({
        eligible_refund_categories: ['Overpayment'],
        remaining_ngn: 999,
        suggested_preview_amount_ngn: 5000,
      })
    ).toBe(false);
    expect(
      quotationMeetsRefundPickerFloor({
        eligible_refund_categories: ['Overpayment'],
        remaining_ngn: 5000,
        suggested_preview_amount_ngn: 500,
      })
    ).toBe(false);
    expect(
      quotationMeetsRefundPickerFloor({
        eligible_refund_categories: [],
        remaining_ngn: 5000,
        suggested_preview_amount_ngn: 5000,
      })
    ).toBe(false);
  });

  it('exposes amount vs lines tolerance', () => {
    expect(REFUND_AMOUNT_LINE_TOLERANCE_NGN).toBe(1);
  });

  it('gates economic floor only on production-related lines', () => {
    const mixed = [
      { category: 'Unproduced meterage', amountNgn: 113_640 },
      { category: 'Overpayment', amountNgn: 2_320 },
    ];
    expect(refundFloorGatedAmountNgn(mixed)).toBe(113_640);
    expect(
      refundAmountExceedsEconomicFloorCap({
        amountNgn: 115_960,
        calculationLines: mixed,
        categories: ['Unproduced meterage', 'Overpayment'],
        maxDefensibleRefundNgn: 113_640,
      })
    ).toBe(false);
    expect(
      refundAmountExceedsEconomicFloorCap({
        amountNgn: 115_960,
        calculationLines: [{ category: 'Other', amountNgn: 115_960 }],
        categories: ['Other'],
        maxDefensibleRefundNgn: 113_640,
      })
    ).toBe(true);
    expect(
      refundAmountExceedsEconomicFloorCap({
        amountNgn: 15_000,
        calculationLines: [{ category: 'Additional services', amountNgn: 15_000 }],
        categories: ['Additional services'],
        maxDefensibleRefundNgn: 12_000,
      })
    ).toBe(false);
  });
});
