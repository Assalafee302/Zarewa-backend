import { describe, it, expect } from 'vitest';
import {
  validateQuotationMaterialHeaderRequired,
  assertQuotationMaterialHeaderRequired,
  QUOTATION_MATERIAL_HEADER_CODE,
} from './quotationMaterialHeader.js';

describe('quotationMaterialHeader', () => {
  it('requires all four header fields', () => {
    const r = validateQuotationMaterialHeaderRequired({
      materialTypeId: 'MAT-002',
      materialGauge: '0.45mm',
      materialColor: 'Charcoal',
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe(QUOTATION_MATERIAL_HEADER_CODE);
    expect(r.details.missing).toContain('profile');
  });

  it('passes when complete', () => {
    expect(
      validateQuotationMaterialHeaderRequired({
        materialTypeId: 'MAT-002',
        materialGauge: '0.45mm',
        materialColor: 'Charcoal',
        materialDesign: 'Longspan (Indus6)',
      }).ok
    ).toBe(true);
  });

  it('assert throws with status 422', () => {
    try {
      assertQuotationMaterialHeaderRequired({});
      expect.unreachable('should throw');
    } catch (e) {
      expect(e.code).toBe(QUOTATION_MATERIAL_HEADER_CODE);
      expect(e.statusCode).toBe(422);
    }
  });
});
