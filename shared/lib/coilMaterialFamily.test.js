import { describe, expect, it } from 'vitest';
import {
  coilAndProductMaterialFamiliesConflict,
  materialFamilyKeyForConversion,
} from './coilMaterialFamily.js';

describe('materialFamilyKeyForConversion', () => {
  it('classifies aluminium spellings', () => {
    expect(materialFamilyKeyForConversion('Aluminium')).toBe('aluminium');
    expect(materialFamilyKeyForConversion('  aluminum  ')).toBe('aluminium');
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

describe('coilAndProductMaterialFamiliesConflict', () => {
  it('detects aluminium coil vs aluzinc product', () => {
    expect(coilAndProductMaterialFamiliesConflict('Aluminium', 'Aluzinc')).toBe(true);
  });

  it('allows same family', () => {
    expect(coilAndProductMaterialFamiliesConflict('Aluminium', 'Aluminium')).toBe(false);
    expect(coilAndProductMaterialFamiliesConflict('Aluzinc', 'Aluzinc')).toBe(false);
  });

  it('does not block when coil family is unknown', () => {
    expect(coilAndProductMaterialFamiliesConflict('Custom alloy', 'Aluzinc')).toBe(false);
  });

  it('does not block when product family is unknown', () => {
    expect(coilAndProductMaterialFamiliesConflict('Aluminium', '')).toBe(false);
  });
});
