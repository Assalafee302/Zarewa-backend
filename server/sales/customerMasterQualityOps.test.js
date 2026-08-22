import { describe, expect, it } from 'vitest';
import { customerNameQualityFlags, normalizeCustomerPhoneDigits } from './customerMasterQualityOps.js';

describe('customerMasterQualityOps', () => {
  it('flags leading percent and placeholder names', () => {
    expect(customerNameQualityFlags('% BONI')).toContain('leading_percent');
    expect(customerNameQualityFlags('test')).toContain('placeholder_name');
    expect(customerNameQualityFlags('A')).toContain('too_short');
    expect(customerNameQualityFlags('muhammed aminu')).toEqual([]);
  });

  it('normalizes Nigerian-style phone numbers to last 10 digits', () => {
    expect(normalizeCustomerPhoneDigits('07037300182')).toBe('7037300182');
    expect(normalizeCustomerPhoneDigits('+234 703 730 0182')).toBe('7037300182');
    expect(normalizeCustomerPhoneDigits('')).toBe('');
  });
});
