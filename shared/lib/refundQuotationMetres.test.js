import { describe, expect, it } from 'vitest';
import { quotedCoilSheetPoolMetresFromLines, quotedRoofingSheetMetresFromLines } from './refundQuotationMetres.js';

describe('refundQuotationMetres', () => {
  it('includes cladding in coil sheet pool when products payload exists', () => {
    const lines = {
      products: [
        { name: 'Roofing Sheet', qty: 100 },
        { name: 'Cladding', qty: 12 },
      ],
    };
    expect(quotedRoofingSheetMetresFromLines(lines)).toBe(100);
    expect(quotedCoilSheetPoolMetresFromLines(lines)).toBe(112);
  });
});
