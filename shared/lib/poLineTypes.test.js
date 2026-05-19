import { describe, it, expect } from 'vitest';
import {
  PO_LINE_TYPES,
  inferLineTypeFromProduct,
  validatePoLine,
  deriveProcurementKindFromLineTypes,
  deriveProcurementKindFromPoLines,
  stoneFlatsheetSheetsToM2,
  grnKindForPoLine,
  STONE_FLATSHEET_WIDTH_M,
} from './poLineTypes.js';

describe('poLineTypes', () => {
  it('infers line types from product ids', () => {
    expect(inferLineTypeFromProduct('ACC-TAPPING-SCREW-PCS')).toBe('accessory');
    expect(inferLineTypeFromProduct('STONE-FS-BLK-2M')).toBe('stone_flatsheet');
    expect(inferLineTypeFromProduct('STONE-MILANO-BLK-045')).toBe('stone_meter');
    expect(inferLineTypeFromProduct('COIL-ALU')).toBe('coil_kg');
    expect(
      inferLineTypeFromProduct('COIL-ALU', null, {
        metersOffered: 10,
        qtyOrdered: 10,
        unitPricePerKgNgn: 0,
      })
    ).toBe('coil_meter');
  });

  it('validates required fields per line type', () => {
    expect(
      validatePoLine({
        lineType: 'coil_kg',
        productID: 'COIL-ALU',
        qtyOrdered: 100,
        color: 'IV',
        gauge: '0.24',
      }).ok
    ).toBe(true);
    expect(
      validatePoLine({
        lineType: 'stone_flatsheet',
        productID: 'STONE-FS-BLK-2M',
        qtyOrdered: 50,
        metersOffered: 2,
      }).ok
    ).toBe(true);
    expect(validatePoLine({ lineType: 'coil_kg', productID: 'COIL-ALU', qtyOrdered: 0 }).ok).toBe(false);
  });

  it('derives procurement kind including mixed', () => {
    expect(deriveProcurementKindFromLineTypes(['coil_kg', 'coil_kg'])).toBe('coil');
    expect(deriveProcurementKindFromLineTypes(['stone_meter', 'accessory'])).toBe('mixed');
    expect(
      deriveProcurementKindFromPoLines([
        { productID: 'STONE-FS-BLK-2M', lineType: 'stone_flatsheet' },
        { productID: 'COIL-ALU', lineType: 'coil_kg' },
      ])
    ).toBe('mixed');
  });

  it('converts flatsheet sheets to m²', () => {
    expect(stoneFlatsheetSheetsToM2(50, 2)).toBeCloseTo(50 * 2 * STONE_FLATSHEET_WIDTH_M, 5);
  });

  it('maps GRN UI kind per line', () => {
    expect(grnKindForPoLine({ lineType: 'stone_flatsheet' })).toBe('stone_flatsheet');
    expect(grnKindForPoLine({ lineType: 'coil_meter' })).toBe('coil');
    expect(PO_LINE_TYPES.length).toBe(5);
  });
});
