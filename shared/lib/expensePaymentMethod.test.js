import { describe, expect, it } from 'vitest';
import { expensePaymentMethodFromAccountTypes } from './expensePaymentMethod.js';

describe('expensePaymentMethodFromAccountTypes', () => {
  it('maps cash and bank treasury types, and Mixed when both appear', () => {
    expect(expensePaymentMethodFromAccountTypes(['Cash'])).toBe('Cash');
    expect(expensePaymentMethodFromAccountTypes(['cash'])).toBe('Cash');
    expect(expensePaymentMethodFromAccountTypes(['Bank'])).toBe('Bank');
    expect(expensePaymentMethodFromAccountTypes(['Cash', 'Bank'])).toBe('Mixed');
    expect(expensePaymentMethodFromAccountTypes([])).toBe('Mixed');
  });
});
