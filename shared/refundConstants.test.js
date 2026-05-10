import { describe, it, expect } from 'vitest';
import {
  normalizeRefundReasonCategoriesForApi,
  REFUND_PREVIEW_VERSION,
  MIN_REFUND_QUOTATION_REMAINING_NGN,
  REFUND_AMOUNT_LINE_TOLERANCE_NGN,
} from './refundConstants.js';

describe('refundConstants', () => {
  it('normalizes legacy category labels to canonical values', () => {
    expect(normalizeRefundReasonCategoriesForApi(['Transport refund', 'Accessory refund'])).toEqual([
      'Transport issue',
      'Accessory shortfall',
    ]);
    expect(normalizeRefundReasonCategoriesForApi('Substitution pricing')).toEqual(['Substitution Difference']);
    expect(normalizeRefundReasonCategoriesForApi('Agent commission')).toEqual(['Customer commission']);
    expect(normalizeRefundReasonCategoriesForApi('Adjustment')).toEqual(['Other']);
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

  it('exposes amount vs lines tolerance', () => {
    expect(REFUND_AMOUNT_LINE_TOLERANCE_NGN).toBe(1);
  });
});
