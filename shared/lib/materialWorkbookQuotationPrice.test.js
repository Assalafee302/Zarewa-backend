import { describe, expect, it } from 'vitest';
import {
  canonicalPriceListDesignKey,
  designKeysToTry,
  isMeterSheetProductLine,
  publishedListPriceFromWorkbook,
  resolveMaterialWorkbookPriceFromRows,
  resolvePublishedListUnitNgnFromItems,
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

  it('maps quotation profile labels onto publish design keys', () => {
    expect(canonicalPriceListDesignKey('Longspan (Indus6)')).toBe('longspan');
    expect(canonicalPriceListDesignKey('Longspan (Metra)')).toBe('longspan');
    expect(canonicalPriceListDesignKey('Roman')).toBe('rome');
    expect(canonicalPriceListDesignKey('Steptile')).toBe('steptiles');
    expect(designKeysToTry('Longspan (Indus6)')).toContain('longspan');
  });

  it('prefers workbook blank/wb row over stale design_key=longspan duplicate', () => {
    const mixed = [
      {
        id: 'MPS-LEGACY',
        materialKey: 'aluzinc',
        gaugeMm: '0.24',
        branchId: 'BR-KD',
        designKey: 'longspan',
        minimumPricePerMeterNgn: 4800,
        commissionNgnPerM: 0,
        publishedListPriceNgn: 4800,
      },
      {
        id: 'MPS-UI',
        materialKey: 'aluzinc',
        gaugeMm: '0.24',
        branchId: 'BR-KD',
        designKey: '',
        syncDesignKey: 'longspan',
        minimumPricePerMeterNgn: 4700,
        commissionNgnPerM: 0,
        publishedListPriceNgn: 4700,
      },
    ];
    const hit = resolveMaterialWorkbookPriceFromRows(mixed, {
      materialKey: 'aluzinc',
      gaugeMm: '0.24mm',
      branchId: 'BR-KD',
      designLabel: 'Longspan (Indus6)',
    });
    expect(hit?.floorPerMeter).toBe(4700);
    expect(hit?.rowId).toBe('MPS-UI');
  });

  it('treats Flat sheet product name as unset design so primary gauge floor applies', () => {
    const rows020 = [
      {
        id: 'MPS-020',
        materialKey: 'aluzinc',
        gaugeMm: '0.20',
        branchId: 'BR-KD',
        designKey: '',
        syncDesignKey: 'longspan',
        minimumPricePerMeterNgn: 3850,
        commissionNgnPerM: 0,
        publishedListPriceNgn: 3850,
      },
      {
        id: 'MPS-020-LEGACY',
        materialKey: 'aluzinc',
        gaugeMm: '0.20',
        branchId: 'BR-KD',
        designKey: 'longspan',
        minimumPricePerMeterNgn: 3900,
        commissionNgnPerM: 0,
        publishedListPriceNgn: 3900,
      },
    ];
    const hit = resolveMaterialWorkbookPriceFromRows(rows020, {
      materialKey: 'aluzinc',
      gaugeMm: '0.20mm',
      branchId: 'BR-KD',
      designLabel: 'Flat sheet',
    });
    expect(hit?.floorPerMeter).toBe(3850);
    expect(hit?.rowId).toBe('MPS-020');
  });

  it('matches Longspan (Indus6) to published longspan workbook rows', () => {
    const hit = resolveMaterialWorkbookPriceFromRows(rows, {
      materialKey: 'aluzinc',
      gaugeMm: '0.45mm',
      branchId: 'BR-001',
      designLabel: 'Longspan (Indus6)',
    });
    expect(hit?.floorPerMeter).toBe(4000);
    expect(hit?.suggestedListPerMeter).toBe(4200);
  });

  it('does not fall back to min floor across designs when design is unmatched', () => {
    const hit = resolveMaterialWorkbookPriceFromRows(rows, {
      materialKey: 'aluzinc',
      gaugeMm: '0.45mm',
      branchId: 'BR-001',
      designLabel: 'UnknownDesign',
    });
    expect(hit).toBeNull();
  });

  it('does not fuzzy-match design via includes', () => {
    const hit = resolveMaterialWorkbookPriceFromRows(rows, {
      materialKey: 'aluzinc',
      gaugeMm: '0.45mm',
      branchId: 'BR-001',
      designLabel: 'long',
    });
    expect(hit).toBeNull();
  });

  it('uses blank design row when design keys are empty', () => {
    const withBlank = [
      ...rows,
      {
        id: 'MPS-blank',
        materialKey: 'aluzinc',
        gaugeMm: '0.45',
        branchId: 'BR-001',
        designKey: '',
        minimumPricePerMeterNgn: 3900,
        commissionNgnPerM: 100,
        publishedListPriceNgn: 4000,
      },
    ];
    const hit = resolveMaterialWorkbookPriceFromRows(withBlank, {
      materialKey: 'aluzinc',
      gaugeMm: '0.45mm',
      branchId: 'BR-001',
      designLabel: '',
    });
    expect(hit?.floorPerMeter).toBe(3900);
    expect(hit?.rowId).toBe('MPS-blank');
  });

  it('publishedListPriceFromWorkbook rounds floor + commission', () => {
    expect(publishedListPriceFromWorkbook(4010, 90)).toBe(4100);
  });

  it('resolvePublishedListUnitNgnFromItems prefers workbook publish over stale admin rows', () => {
    const items = [
      {
        id: 'PL-OLD',
        gaugeKey: '0.45mm',
        designKey: 'long span',
        materialTypeKey: 'aluzinc',
        branchId: 'BR-001',
        unitPricePerMeterNgn: 5000,
        effectiveFromIso: '2026-01-01',
      },
      {
        id: 'PL-MPS-NEW',
        gaugeKey: '0.45',
        designKey: 'longspan',
        materialTypeKey: 'aluzinc',
        branchId: 'BR-001',
        unitPricePerMeterNgn: 4200,
        effectiveFromIso: '2026-08-14',
      },
    ];
    const n = resolvePublishedListUnitNgnFromItems(items, {
      gaugeLabel: '0.45mm',
      designLabel: 'Longspan (Indus6)',
      materialTypeKey: 'aluzinc',
      branchId: 'BR-001',
    });
    expect(n).toBe(4200);
  });

  it('resolvePublishedListUnitNgnFromItems prefers branch publish over richer global PL-MPS', () => {
    const items = [
      {
        id: 'PL-MPS-GL',
        gaugeKey: '0.28mm',
        designKey: 'longspan',
        materialTypeKey: 'alu',
        branchId: '',
        unitPricePerMeterNgn: 4000,
        effectiveFromIso: '2026-09-01',
      },
      {
        id: 'PL-MPS-YL',
        gaugeKey: '0.28',
        designKey: 'longspan',
        materialTypeKey: 'alu',
        branchId: 'BR-YL',
        unitPricePerMeterNgn: 4550,
        effectiveFromIso: '2026-09-01',
      },
    ];
    expect(
      resolvePublishedListUnitNgnFromItems(items, {
        gaugeLabel: '0.35mm',
        designLabel: 'longspan',
        materialTypeKey: 'alu',
        branchId: 'BR-YL',
      })
    ).toBe(4550);
  });

  it('resolvePublishedListUnitNgnFromItems maps Yola 0.30 trade label to canonical 0.24 publish', () => {
    const items = [
      {
        id: 'PL-MPS-TRUE30',
        gaugeKey: '0.30mm',
        designKey: 'longspan',
        materialTypeKey: 'alu',
        branchId: 'BR-YL',
        unitPricePerMeterNgn: 9999,
        effectiveFromIso: '2026-09-01',
      },
      {
        id: 'PL-MPS-024',
        gaugeKey: '0.24mm',
        designKey: 'longspan',
        materialTypeKey: 'alu',
        branchId: 'BR-YL',
        unitPricePerMeterNgn: 3800,
        effectiveFromIso: '2026-09-01',
      },
    ];
    expect(
      resolvePublishedListUnitNgnFromItems(items, {
        gaugeLabel: '0.30mm',
        designLabel: 'longspan',
        materialTypeKey: 'alu',
        branchId: 'BR-YL',
      })
    ).toBe(3800);
  });
});
