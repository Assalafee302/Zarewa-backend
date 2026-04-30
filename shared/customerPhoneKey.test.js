import { describe, it, expect } from 'vitest';
import { normalizeCustomerPhoneKey, normalizeCustomerEmailKey } from './customerPhoneKey.js';

describe('customerPhoneKey', () => {
  it('normalizes Nigerian variants to the same key', () => {
    const k = '8035550142';
    expect(normalizeCustomerPhoneKey('+234 803 555 0142')).toBe(k);
    expect(normalizeCustomerPhoneKey('08035550142')).toBe(k);
    expect(normalizeCustomerPhoneKey('2348035550142')).toBe(k);
  });

  it('returns empty when no digits', () => {
    expect(normalizeCustomerPhoneKey('')).toBe('');
    expect(normalizeCustomerPhoneKey('—')).toBe('');
  });

  it('normalizes email', () => {
    expect(normalizeCustomerEmailKey('  Test@Example.COM ')).toBe('test@example.com');
    expect(normalizeCustomerEmailKey('')).toBe('');
  });
});
