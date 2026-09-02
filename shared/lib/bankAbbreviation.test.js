import { describe, expect, it } from 'vitest';
import { abbreviateBankName } from './bankAbbreviation.js';

describe('abbreviateBankName', () => {
  it('maps known bank names to short codes', () => {
    expect(abbreviateBankName('Guaranty Trust Bank Plc')).toBe('GTB');
    expect(abbreviateBankName('united bank for africa')).toBe('UBA');
    expect(abbreviateBankName('Zenith Bank')).toBe('ZENITH');
    expect(abbreviateBankName('First Bank of Nigeria')).toBe('FIRSTBANK');
  });

  it('falls back to initials for unrecognized banks', () => {
    expect(abbreviateBankName('Coastline Merchant Bank')).toBe('CMB');
  });

  it('returns empty string for empty input', () => {
    expect(abbreviateBankName('')).toBe('');
    expect(abbreviateBankName(null)).toBe('');
  });
});
