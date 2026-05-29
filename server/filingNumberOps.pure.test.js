import { describe, it, expect } from 'vitest';
import { filingPrefixForCategory } from './filingNumberOps.js';

describe('filingPrefixForCategory', () => {
  it('maps categories', () => {
    expect(filingPrefixForCategory('fuel_diesel')).toBe('FUEL');
    expect(filingPrefixForCategory('maintenance_repairs')).toBe('MNT');
  });
});
