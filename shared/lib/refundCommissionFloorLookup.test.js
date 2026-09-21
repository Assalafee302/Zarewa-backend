import { describe, expect, it } from 'vitest';
import {
  firstQuotedProductGaugeDesign,
  quotationMaterialTypeIdFromLines,
  quotedGaugeDesignForCommission,
  STONE_COATED_COMMISSION_DESIGN_KEY,
} from './refundCommissionFloorLookup.js';

describe('refundCommissionFloorLookup', () => {
  it('stone-coated prefers header 0.24 over a product line that only has design on 0.20', () => {
    const lines = {
      materialTypeId: 'MAT-005',
      materialGauge: '0.24mm',
      materialDesign: 'stone-coated',
      products: [
        { name: 'Roofing Sheet', qty: 180, unitPrice: 7350, gauge: '0.20mm', design: 'stone-coated' },
      ],
    };
    expect(quotedGaugeDesignForCommission(lines)).toEqual({
      gauge: '0.24mm',
      design: 'stone-coated',
    });
    // Without header preference, first product would wrongly win:
    expect(firstQuotedProductGaugeDesign(lines)).toEqual({
      gauge: '0.20mm',
      design: 'stone-coated',
    });
  });

  it('stone-coated defaults design when header has gauge only', () => {
    const lines = {
      materialTypeId: 'MAT-005',
      materialGauge: '0.24mm',
      products: [{ name: 'Roofing Sheet', qty: 180, unitPrice: 7350, gauge: '0.24mm' }],
    };
    expect(quotedGaugeDesignForCommission(lines)).toEqual({
      gauge: '0.24mm',
      design: STONE_COATED_COMMISSION_DESIGN_KEY,
    });
  });

  it('quotationMaterialTypeIdFromLines reads MAT-005', () => {
    expect(quotationMaterialTypeIdFromLines({ materialTypeId: 'MAT-005' })).toBe('MAT-005');
    expect(quotationMaterialTypeIdFromLines(JSON.stringify({ materialType: 'MAT-005' }))).toBe('MAT-005');
  });
});
