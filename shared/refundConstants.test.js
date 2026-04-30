import { describe, it, expect } from 'vitest';
import { normalizeRefundReasonCategoriesForApi, REFUND_PREVIEW_VERSION } from './refundConstants.js';

describe('refundConstants', () => {
  it('normalizes legacy category labels to canonical values', () => {
    expect(normalizeRefundReasonCategoriesForApi(['Transport refund', 'Accessory refund'])).toEqual([
      'Transport issue',
      'Accessory shortfall',
    ]);
    expect(normalizeRefundReasonCategoriesForApi('Substitution pricing')).toEqual(['Substitution Difference']);
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
});
