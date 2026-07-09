import { describe, expect, it } from 'vitest';
import {
  customerRidgeListAddOnNgn,
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
});
