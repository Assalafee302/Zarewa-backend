import { describe, it, expect } from 'vitest';
import {
  canonicalColourName,
  coloursMatchWithMaster,
  stockCheckSelectOptionsFromMasterData,
  stockRowMatchesColourFilter,
  stockRowMatchesMaterialTypeFilter,
} from './stockCheckMasterOptions.js';

const masterData = {
  colours: [
    { name: 'Ivory Beige', abbreviation: 'IV', active: true },
    { name: 'Bush Green', abbreviation: 'BG', active: true },
  ],
};

describe('stockCheckMasterOptions colour canonicalization', () => {
  it('maps IV abbreviation to Ivory Beige master name', () => {
    expect(canonicalColourName(masterData, 'IV')).toBe('Ivory Beige');
    expect(canonicalColourName(masterData, 'iv')).toBe('Ivory Beige');
    expect(canonicalColourName(masterData, 'Ivory Beige')).toBe('Ivory Beige');
  });

  it('treats IV and Ivory Beige as the same for stock filters', () => {
    const row = { colour: 'IV', colourRaw: 'IV' };
    expect(stockRowMatchesColourFilter(masterData, 'Ivory Beige', row)).toBe(true);
    expect(stockRowMatchesColourFilter(masterData, 'IV', { colour: 'Ivory Beige', colourRaw: 'Ivory Beige' })).toBe(
      true
    );
    expect(coloursMatchWithMaster(masterData, 'IV', 'Ivory Beige')).toBe(true);
  });
});

describe('stockCheckSelectOptionsFromMasterData', () => {
  it('includes Stain (stain_meter) and excludes finished-good types', () => {
    const { types } = stockCheckSelectOptionsFromMasterData({
      materialTypes: [
        { id: 'MAT-001', name: 'Aluminium', inventoryModel: 'coil_kg', active: true },
        { id: 'MAT-006', name: 'Stain', inventoryModel: 'stain_meter', active: true },
        { id: 'MAT-003', name: 'Longspan (finished)', inventoryModel: 'finished_good', active: true },
      ],
      gauges: [],
      colours: [],
    });
    expect(types.map((t) => t.value).sort()).toEqual(['MAT-001', 'MAT-006']);
  });

  it('Type = Stain matches stain inventory rows, not parent-family coils', () => {
    const md = {
      materialTypes: [{ id: 'MAT-006', name: 'Stain', inventoryModel: 'stain_meter', active: true }],
    };
    expect(
      stockRowMatchesMaterialTypeFilter(md, 'MAT-006', {
        poolKind: 'stain',
        materialType: 'Stain',
        estMeters: 40,
      })
    ).toBe(true);
    expect(stockRowMatchesMaterialTypeFilter(md, 'MAT-006', { materialType: 'Aluzinc', kg: 800 })).toBe(false);
    expect(stockRowMatchesMaterialTypeFilter(md, 'MAT-006', 'Stain')).toBe(true);
  });

  it('Type = Stone coated matches stone SKU rows, not coil lots', () => {
    const md = {
      materialTypes: [{ id: 'MAT-005', name: 'Stone coated', inventoryModel: 'stone_meter', active: true }],
    };
    expect(
      stockRowMatchesMaterialTypeFilter(md, 'MAT-005', {
        productID: 'STONE-bond-red-0.50mm',
        materialType: 'Stone coated',
        dashboardAttrs: { inventoryModel: 'stone_meter', stoneDesign: 'Bond' },
        estMeters: 80,
      })
    ).toBe(true);
    expect(stockRowMatchesMaterialTypeFilter(md, 'MAT-005', { materialType: 'Aluzinc', kg: 800 })).toBe(false);
  });
});
