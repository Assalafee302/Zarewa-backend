import { describe, expect, it } from 'vitest';
import {
  materialFamilyKeyForConversion,
  procurementCatalogMaterialAlignedWithCoil,
  resolveCoilMaterialFamilyKey,
} from './coilMaterialFamily.js';

describe('materialFamilyKeyForConversion', () => {
  it('classifies aluminium spellings', () => {
    expect(materialFamilyKeyForConversion('Aluminium')).toBe('aluminium');
    expect(materialFamilyKeyForConversion('  aluminum  ')).toBe('aluminium');
  });

  it('classifies short ALU', () => {
    expect(materialFamilyKeyForConversion('ALU')).toBe('aluminium');
    expect(materialFamilyKeyForConversion('alu-0.5')).toBe('aluminium');
  });

  it('classifies aluzinc / galvalume', () => {
    expect(materialFamilyKeyForConversion('Aluzinc')).toBe('aluzinc');
    expect(materialFamilyKeyForConversion('ALUZINC 0.55')).toBe('aluzinc');
    expect(materialFamilyKeyForConversion('Galvalume')).toBe('aluzinc');
  });

  it('returns null for unknown or empty', () => {
    expect(materialFamilyKeyForConversion('')).toBe(null);
    expect(materialFamilyKeyForConversion('  ')).toBe(null);
    expect(materialFamilyKeyForConversion('Titanium')).toBe(null);
  });
});

describe('resolveCoilMaterialFamilyKey', () => {
  it('uses setup canonical name when raw label has no keyword', () => {
    expect(resolveCoilMaterialFamilyKey('Custom label', 'Aluminium')).toBe('aluminium');
  });

  it('prefers raw label when it parses', () => {
    expect(resolveCoilMaterialFamilyKey('Aluminium', 'Aluzinc')).toBe('aluminium');
  });
});

describe('procurementCatalogMaterialAlignedWithCoil', () => {
  it('blocks catalogue when coil is aluminium but product material is missing', () => {
    expect(procurementCatalogMaterialAlignedWithCoil('aluminium', '')).toBe(false);
    expect(procurementCatalogMaterialAlignedWithCoil('aluminium', '   ')).toBe(false);
  });

  it('blocks when coil is aluminium and product is aluzinc', () => {
    expect(procurementCatalogMaterialAlignedWithCoil('aluminium', 'Aluzinc')).toBe(false);
  });

  it('allows when families match', () => {
    expect(procurementCatalogMaterialAlignedWithCoil('aluminium', 'Aluminium')).toBe(true);
    expect(procurementCatalogMaterialAlignedWithCoil('aluzinc', 'Aluzinc')).toBe(true);
  });

  it('allows catalogue when coil family unknown', () => {
    expect(procurementCatalogMaterialAlignedWithCoil(null, 'Aluzinc')).toBe(true);
  });
});
