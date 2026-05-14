import { describe, expect, it } from 'vitest';
import { quotationExpectsCoilAllocation } from './coilSpecVersusProduct.js';
import {
  accessoryLineAllowedForStone,
  applyStoneMeterMaterialChangeCleanup,
  productLineAllowedForStone,
  quotationHasCoilLine,
  quotationHasFlatSheetLine,
  validateQuotationMaterialRules,
} from './stoneCoatedQuotationPolicy.js';

/** Minimal db stub matching better-sqlite3 prepare().get/.all API used by the policy. */
function createPolicyTestDb(overrides = {}) {
  const state = {
    materialTypes: [
      { material_type_id: 'MAT-005', name: 'Stone coated', inventory_model: 'stone_meter', active: 1 },
      { material_type_id: 'MAT-002', name: 'Aluzinc', inventory_model: 'coil_kg', active: 1 },
    ],
    gauges: [{ label: '0.45mm', active: 1 }],
    colours: [
      { colour_id: 'C1', name: 'Black', active: 1 },
      { colour_id: 'C2', name: 'HM Blue', active: 1 },
    ],
    profiles: [{ name: 'Milano', active: 1, material_type_id: 'MAT-005' }],
    priceColourIds: overrides.priceColourIds !== undefined ? overrides.priceColourIds : ['C1'],
    priceListWorkbookColours: overrides.priceListWorkbookColours ?? [],
  };
  return {
    prepare(sql) {
      const s = String(sql || '');
      return {
        get(...args) {
          if (s.includes('setup_material_types')) {
            const id = args[0];
            const row = state.materialTypes.find((r) => r.material_type_id === id);
            if (!row) return null;
            if (s.includes('inventory_model') && !s.includes(' AS id')) {
              return { inventory_model: row.inventory_model };
            }
            return {
              id: row.material_type_id,
              name: row.name,
              material_type_id: row.material_type_id,
              inventory_model: row.inventory_model,
            };
          }
          if (s.includes('setup_gauges')) {
            const label = args[0];
            return state.gauges.some((g) => g.label === label && g.active) ? { ok: 1 } : undefined;
          }
          if (s.includes('setup_colours') && s.includes('colour_id')) {
            const name = args[0];
            return state.colours.find((c) => c.name === name && c.active) || null;
          }
          return null;
        },
        all(...args) {
          if (s.includes('price_list_items') && s.includes('colour_key')) {
            return state.priceListWorkbookColours;
          }
          if (s.includes('setup_price_lists') && s.includes('colour_id')) {
            return state.priceColourIds.map((colour_id) => ({ colour_id }));
          }
          if (s.includes('setup_profiles') && s.includes('material_type_id')) {
            const mid = args[0];
            return state.profiles.filter((p) => p.material_type_id === mid && p.active);
          }
          return [];
        },
      };
    },
  };
}

describe('stoneCoatedQuotationPolicy — line rules', () => {
  it('allows stone products and ridge cap', () => {
    expect(productLineAllowedForStone('Roofing Sheet', false)).toBe(true);
    expect(productLineAllowedForStone('Stone flatsheet', false)).toBe(true);
    expect(productLineAllowedForStone('Ridge Cap', false)).toBe(true);
    expect(productLineAllowedForStone('Gutter', false)).toBe(true);
  });

  it('maps Flatsheet to flat sheet', () => {
    expect(productLineAllowedForStone('Flatsheet', false)).toBe(true);
  });

  it('blocks coil without flat sheet', () => {
    expect(productLineAllowedForStone('Coil', false)).toBe(false);
    expect(productLineAllowedForStone('Coil', true)).toBe(true);
  });

  it('detects flat sheet for coil rule', () => {
    expect(quotationHasFlatSheetLine([{ name: 'Flat sheet' }])).toBe(true);
    expect(quotationHasFlatSheetLine([{ name: 'Flatsheet' }])).toBe(true);
    expect(quotationHasFlatSheetLine([{ name: 'Coil' }])).toBe(false);
  });

  it('detects coil line', () => {
    expect(quotationHasCoilLine([{ name: 'Coil' }])).toBe(true);
  });

  it('allows stone accessories with pack suffix', () => {
    expect(accessoryLineAllowedForStone('Stone nail')).toBe(true);
    expect(accessoryLineAllowedForStone('Stone nail (pack)')).toBe(true);
    expect(accessoryLineAllowedForStone('Repair Kit')).toBe(true);
    expect(accessoryLineAllowedForStone('Concrete nail')).toBe(false);
  });
});

describe('validateQuotationMaterialRules', () => {
  it('passes valid stone quote', () => {
    const db = createPolicyTestDb();
    const r = validateQuotationMaterialRules(db, {
      materialTypeId: 'MAT-005',
      materialGauge: '0.45mm',
      materialColor: 'Black',
      materialDesign: 'Milano',
      products: [{ name: 'Roofing Sheet' }],
      accessories: [{ name: 'Stone nail' }],
    });
    expect(r.ok).toBe(true);
  });

  it('allows stone header colour from workbook when setup omits colour_id', () => {
    const db = createPolicyTestDb({ priceColourIds: [], priceListWorkbookColours: [{ colour_key: 'Black' }] });
    const r = validateQuotationMaterialRules(db, {
      materialTypeId: 'MAT-005',
      materialGauge: '0.45mm',
      materialColor: 'Black',
      materialDesign: 'Milano',
      products: [{ name: 'Roofing Sheet' }],
      accessories: [{ name: 'Stone nail' }],
    });
    expect(r.ok).toBe(true);
  });

  it('rejects stone header colour not on workbook when setup omits colour_id', () => {
    const db = createPolicyTestDb({ priceColourIds: [], priceListWorkbookColours: [{ colour_key: 'black' }] });
    const r = validateQuotationMaterialRules(db, {
      materialTypeId: 'MAT-005',
      materialGauge: '0.45mm',
      materialColor: 'HM Blue',
      materialDesign: 'Milano',
      products: [{ name: 'Roofing Sheet' }],
      accessories: [{ name: 'Stone nail' }],
    });
    expect(r.ok).toBe(false);
    expect(r.details?.invalidHeader?.colour).toBe(true);
  });

  it('rejects coil without flat sheet', () => {
    const db = createPolicyTestDb();
    const r = validateQuotationMaterialRules(db, {
      materialTypeId: 'MAT-005',
      materialGauge: '0.45mm',
      materialColor: 'Black',
      materialDesign: 'Milano',
      products: [{ name: 'Coil' }],
      accessories: [],
    });
    expect(r.ok).toBe(false);
    expect(r.details.invalidProductNames).toContain('Coil');
  });

  it('allows coil with flat sheet', () => {
    const db = createPolicyTestDb();
    const r = validateQuotationMaterialRules(db, {
      materialTypeId: 'MAT-005',
      materialGauge: '0.45mm',
      materialColor: 'Black',
      materialDesign: 'Milano',
      products: [{ name: 'Flat sheet' }, { name: 'Coil' }],
      accessories: [],
    });
    expect(r.ok).toBe(true);
  });

  it('rejects stone flatsheet with qty but no length', () => {
    const db = createPolicyTestDb();
    const r = validateQuotationMaterialRules(db, {
      materialTypeId: 'MAT-005',
      materialGauge: '0.45mm',
      materialColor: 'Black',
      materialDesign: 'Milano',
      products: [{ name: 'Stone flatsheet', qty: '10' }],
      accessories: [],
    });
    expect(r.ok).toBe(false);
    expect(r.details.stoneFlatsheetLengthMissing?.length).toBeGreaterThan(0);
  });

  it('skips stone rules for coil material type', () => {
    const db = createPolicyTestDb();
    const r = validateQuotationMaterialRules(db, {
      materialTypeId: 'MAT-002',
      materialGauge: '0.45mm',
      materialColor: 'Black',
      materialDesign: 'Longspan',
      products: [{ name: 'Coil' }, { name: 'Random product' }],
      accessories: [{ name: 'Anything' }],
    });
    expect(r.ok).toBe(true);
  });
});

describe('quotationExpectsCoilAllocation (stone hybrid)', () => {
  it('skips coil for pure stone roofing', () => {
    expect(
      quotationExpectsCoilAllocation({
        stoneMeterQuote: true,
        quotationLines: { products: [{ name: 'Roofing Sheet' }] },
      })
    ).toBe(false);
  });
  it('expects coil when stone quote has Flat sheet', () => {
    expect(
      quotationExpectsCoilAllocation({
        stoneMeterQuote: true,
        quotationLines: { products: [{ name: 'Flat sheet' }] },
      })
    ).toBe(true);
  });
  it('expects coil when stone quote lists Coil', () => {
    expect(
      quotationExpectsCoilAllocation({
        stoneMeterQuote: true,
        quotationLines: { products: [{ name: 'Coil' }] },
      })
    ).toBe(true);
  });
});

describe('applyStoneMeterMaterialChangeCleanup', () => {
  it('removes coil when no flat sheet', () => {
    const r = applyStoneMeterMaterialChangeCleanup({
      toStoneMeter: true,
      products: [{ id: '1', name: 'Coil' }],
      accessories: [],
      materialGauge: '0.45mm',
      materialColor: 'X',
      materialDesign: 'Milano',
      allowedProfileKeys: new Set(['milano']),
    });
    expect(r.products.length).toBe(0);
    expect(r.removedProducts).toContain('Coil');
  });
});
