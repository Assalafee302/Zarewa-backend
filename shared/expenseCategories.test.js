import { describe, expect, it } from 'vitest';
import {
  EXPENSE_CATEGORY_OPTIONS,
  isAllowedExpenseCategory,
  isCapexExpenseCategory,
  capexExpenseAssetMeta,
  mapLegacyExpenseCategoryToCanonical,
} from './expenseCategories.js';

describe('expenseCategories', () => {
  it('rejects free-text categories', () => {
    expect(isAllowedExpenseCategory('random text')).toBe(false);
    expect(isAllowedExpenseCategory('')).toBe(false);
  });

  it('accepts canonical options', () => {
    for (const c of EXPENSE_CATEGORY_OPTIONS) {
      expect(isAllowedExpenseCategory(c)).toBe(true);
    }
  });

  it('mapLegacy leaves canonical values unchanged', () => {
    expect(mapLegacyExpenseCategoryToCanonical('Bank charges')).toBe('Bank charges');
    expect(mapLegacyExpenseCategoryToCanonical('Rent & utilities')).toBe('Rent & utilities');
  });

  it('mapLegacy maps prior canonical strings', () => {
    expect(mapLegacyExpenseCategoryToCanonical('Plant consumables')).toBe('Accessories');
    expect(mapLegacyExpenseCategoryToCanonical('PHCN / diesel top-up')).toBe('Rent & utilities');
    expect(mapLegacyExpenseCategoryToCanonical('COGS — consumables & supplies')).toBe('Accessories');
    expect(mapLegacyExpenseCategoryToCanonical('Logistics & haulage')).toBe('Truck & mining');
  });

  it('mapLegacy uses heuristics then fallback', () => {
    expect(mapLegacyExpenseCategoryToCanonical('Office rent March')).toBe('Rent & utilities');
    expect(mapLegacyExpenseCategoryToCanonical('xyz-unknown-label-999')).toBe('Others');
  });

  it('identifies capex categories for fixed-asset automation', () => {
    expect(isCapexExpenseCategory('Plant and machinery')).toBe(true);
    expect(isCapexExpenseCategory('Generator')).toBe(true);
    expect(isCapexExpenseCategory('Rent & utilities')).toBe(false);
    const meta = capexExpenseAssetMeta('Plant and machinery');
    expect(meta.assetCategory).toBe('plant');
    expect(meta.glAccountCode).toBe('1500');
  });
});
