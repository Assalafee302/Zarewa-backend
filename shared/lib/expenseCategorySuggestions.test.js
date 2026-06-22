import { describe, expect, it } from 'vitest';
import {
  suggestExpenseCategoryForActor,
  suggestExpenseCategoryFromMemoText,
} from './expenseCategorySuggestions.js';

describe('suggestExpenseCategoryFromMemoText', () => {
  it('suggests logistics for haulage keywords', () => {
    const r = suggestExpenseCategoryFromMemoText({ subject: 'Haulage', body: 'Pay transporter' });
    expect(r.category).toBe('Truck & mining');
  });

  it('suggests fuel category for diesel without haulage', () => {
    const r = suggestExpenseCategoryFromMemoText({ description: 'Diesel top-up for plant fuel store this week' });
    expect(r.category).toBe('Fuel & lubricant');
  });

  it('returns null when no match', () => {
    const r = suggestExpenseCategoryFromMemoText({ subject: 'Hello', body: 'General note' });
    expect(r.category).toBeNull();
  });
});

describe('suggestExpenseCategoryForActor', () => {
  it('blocks restricted categories for staff', () => {
    const r = suggestExpenseCategoryForActor(
      { description: 'Land and building purchase for new warehouse extension project' },
      { roleKey: 'sales_staff', permissions: ['expenses.create'] },
      (p) => p === 'expenses.create'
    );
    expect(r.suggestedCategory).toBe('Land and buildings');
    expect(r.category).toBeNull();
    expect(r.actorMaySelect).toBe(false);
  });
});
