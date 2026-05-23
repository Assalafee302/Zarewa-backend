import { describe, expect, it } from 'vitest';
import {
  isMeterSheetProductLine,
  publishedListPriceFromWorkbook,
  resolveMaterialWorkbookPriceFromRows,
} from './materialWorkbookQuotationPrice.js';

describe('materialWorkbookQuotationPrice', () => {
  const rows = [
    {
      id: 'MPS-1',
      materialKey: 'aluzinc',
      gaugeMm: '0.45',
      branchId: 'BR-001',
      designKey: 'longspan',
      minimumPricePerMeterNgn: 4000,
      commissionNgnPerM: 200,
      publishedListPriceNgn: 4200,
    },
    {
      id: 'MPS-2',
      materialKey: 'aluzinc',
      gaugeMm: '0.45',
      branchId: 'BR-001',
      designKey: 'metcoppo',
      minimumPricePerMeterNgn: 4500,
      commissionNgnPerM: 250,
      publishedListPriceNgn: 4750,
    },
  ];

  it('isMeterSheetProductLine recognises roofing and flat sheet', () => {
    expect(isMeterSheetProductLine('Roofing sheet')).toBe(true);
    expect(isMeterSheetProductLine('Flat sheet')).toBe(true);
    expect(isMeterSheetProductLine('Screw')).toBe(false);
  });

  it('resolveMaterialWorkbookPriceFromRows matches gauge material design branch', () => {
    const hit = resolveMaterialWorkbookPriceFromRows(rows, {
      materialKey: 'aluzinc',
      gaugeMm: '0.45mm',
      branchId: 'BR-001',
      designLabel: 'Longspan',
    });
    expect(hit?.floorPerMeter).toBe(4000);
    expect(hit?.suggestedListPerMeter).toBe(4200);
  });

  it('publishedListPriceFromWorkbook rounds floor + commission', () => {
    expect(publishedListPriceFromWorkbook(4010, 90)).toBe(4100);
  });
});
