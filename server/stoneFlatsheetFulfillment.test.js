import { describe, expect, it } from 'vitest';
import { isStoneFlatsheetQuotationLine, productLineAllowedForStone } from '../shared/lib/stoneCoatedQuotationPolicy.js';
import {
  parseQuotationStoneFlatsheetLines,
  quotationHasStoneFlatsheetWithQtyButMissingLength,
} from './stoneFlatsheetFulfillment.js';

describe('stoneFlatsheetFulfillment — quotation line detection', () => {
  it('parses Stone flatsheet suffixed names', () => {
    const lines = parseQuotationStoneFlatsheetLines({
      materialColor: 'Black',
      products: [{ id: 'L1', name: 'Stone flatsheet 2', qty: '48' }],
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ name: 'Stone flatsheet 2', orderedM2: 48, lengthM: 2, colourLabel: 'Black' });
  });

  it('does not treat Cladding as stone flatsheet', () => {
    expect(isStoneFlatsheetQuotationLine('Cladding')).toBe(false);
    expect(productLineAllowedForStone('Cladding', false)).toBe(false);
    expect(
      parseQuotationStoneFlatsheetLines({
        materialColor: 'Black',
        products: [{ name: 'Cladding', qty: '36', stoneFlatsheetLengthM: 1.5 }],
      })
    ).toHaveLength(0);
  });

  it('flags stone flatsheet with qty but no length', () => {
    expect(
      quotationHasStoneFlatsheetWithQtyButMissingLength({
        products: [{ name: 'Stone flatsheet', qty: '10' }],
      })
    ).toBe(true);
  });

  it('ignores roofing sheet lines', () => {
    expect(
      parseQuotationStoneFlatsheetLines({
        materialColor: 'Black',
        products: [{ name: 'Roofing Sheet', qty: '120' }],
      })
    ).toHaveLength(0);
  });
});
