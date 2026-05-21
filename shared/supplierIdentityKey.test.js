import { describe, expect, it } from 'vitest';
import {
  collectSupplierIdentityKeys,
  firstSupplierIdentityOverlap,
  normalizeSupplierNameKey,
  normalizeSupplierRegistryKey,
} from './supplierIdentityKey.js';

describe('supplierIdentityKey', () => {
  it('normalizes company name suffixes', () => {
    expect(normalizeSupplierNameKey('Acme Steel Ltd')).toBe('acme steel');
    expect(normalizeSupplierNameKey('Acme Steel Limited')).toBe('acme steel');
  });

  it('detects overlap on name, phone, and registry', () => {
    const a = collectSupplierIdentityKeys('Foo Co', {
      phoneMain: '08031112233',
      rcNumber: 'RC-12345',
    });
    const b = collectSupplierIdentityKeys('Foo Company', {
      whatsapp: '+2348031112233',
      vatTin: 'RC12345',
    });
    expect(firstSupplierIdentityOverlap(a, b)).toBe('name');
    const c = collectSupplierIdentityKeys('Other', { phoneMain: '08031112233' });
    expect(firstSupplierIdentityOverlap(a, c)).toBe('phone');
    expect(normalizeSupplierRegistryKey('RC-12345')).toBe(
      normalizeSupplierRegistryKey('rc12345')
    );
  });
});
