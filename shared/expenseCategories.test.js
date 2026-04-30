import { describe, expect, it } from 'vitest';
import {
  EXPENSE_CATEGORY_OPTIONS,
  isAllowedExpenseCategory,
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
    expect(mapLegacyExpenseCategoryToCanonical('Bank & finance charges')).toBe('Bank & finance charges');
  });

  it('mapLegacy maps known legacy strings', () => {
    expect(mapLegacyExpenseCategoryToCanonical('Plant consumables')).toBe('COGS — consumables & supplies');
    expect(mapLegacyExpenseCategoryToCanonical('PHCN / diesel top-up')).toBe('Operational — rent & utilities');
  });

  it('mapLegacy uses heuristics then fallback', () => {
    expect(mapLegacyExpenseCategoryToCanonical('Office rent March')).toBe('Operational — rent & utilities');
    expect(mapLegacyExpenseCategoryToCanonical('xyz-unknown-label-999')).toBe('Other — misc operating');
  });
});
