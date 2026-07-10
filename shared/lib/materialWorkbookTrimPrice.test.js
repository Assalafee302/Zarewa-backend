import { describe, expect, it } from 'vitest';
import {
  customerRidgeListAddOnNgn,
  quotationTrimWorkbookFloorViolations,
  resolveTrimListPricePerMeterFromWorkbook,
  ridgeMatchedAddOnRow,
} from './materialWorkbookTrimPrice.js';

describe('materialWorkbookTrimPrice', () => {
  const materialPricingRows = [
    {
      materialKey: 'aluzinc',
      gaugeMm: '0.45',
      branchId: 'BR-001',
      designKey: 'longspan',
      minimumPricePerMeterNgn: 4800,
      commissionNgnPerM: 200,
      publishedListPriceNgn: 5000,
    },
  ];

  const ridgeAddOns = [{ girthMm: 400, materialFamily: 'aluzinc', addOnNgn: 80, listAddOnNgn: 100 }];

  it('matches ridge add-on row by material family and girth', () => {
    const row = ridgeMatchedAddOnRow(ridgeAddOns, 'aluzinc', 400);
    expect(row?.addOnNgn).toBe(80);
    expect(customerRidgeListAddOnNgn(row)).toBe(100);
  });

  it('derives trim list price from roofing list base and strip width', () => {
    const price = resolveTrimListPricePerMeterFromWorkbook({
      materialPricingRows,
      ridgeAddOns,
      materialKey: 'aluzinc',
      gaugeLabel: '0.45mm',
      branchId: 'BR-001',
      designLabel: 'Longspan',
      girthMm: 400,
    });
    // 5000 / 3 + 100 = 1766.67 → rounded published
    expect(price).toBeGreaterThan(1700);
    expect(price).toBeLessThan(1800);
  });

  it('flags trim lines priced below workbook floor', () => {
    const violations = quotationTrimWorkbookFloorViolations({
      products: [{ name: 'Ridge cap', qty: 12, unitPrice: 500, girthMm: 400 }],
      materialKey: 'aluzinc',
      gaugeLabel: '0.45mm',
      branchId: 'BR-001',
      designLabel: 'Longspan',
      materialPricingRows,
      ridgeAddOns,
    });
    expect(violations).toHaveLength(1);
    expect(violations[0].trimWorkbook).toBe(true);
    expect(violations[0].code).toBe('below_floor');
    expect(violations[0].priceBasis).toBe('published_list_plus_ridge');
    expect(violations[0].minimumPerMeter).toBe(violations[0].floorPerMeter);
    expect(violations[0].floorPerMeter).toBeGreaterThan(500);
    expect(violations[0].message).toMatch(/trim list/i);
  });
});
