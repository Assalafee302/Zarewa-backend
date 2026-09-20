import { describe, expect, it } from 'vitest';
import {
  applyStainFloorIfNeeded,
  incidentFamilyMatchesStainSource,
  incidentMatchesStainQuoteSpec,
  incidentPoolKind,
  isStainMaterialTypeId,
  quotationIsStainMeterHeader,
  stainFloorFromParentFloor,
  stainPoolRowMatchesQuotation,
  stainWorkbookMaterialTypeId,
  stainSourceMaterialTypeIdToDisplayName,
  buildStainInventorySnapshot,
  stockCheckRowsForMaterialType,
  stockCheckRowsFromStoneProducts,
  STAIN_FLOOR_DISCOUNT_NGN,
  STAIN_MATERIAL_TYPE_ID,
} from './stainMaterialPolicy.js';

describe('stainMaterialPolicy', () => {
  it('recognises MAT-006 and stain aliases', () => {
    expect(isStainMaterialTypeId(STAIN_MATERIAL_TYPE_ID)).toBe(true);
    expect(isStainMaterialTypeId('stain')).toBe(true);
    expect(isStainMaterialTypeId('MAT-002')).toBe(false);
    expect(quotationIsStainMeterHeader({ materialTypeId: 'MAT-006' })).toBe(true);
    expect(quotationIsStainMeterHeader({ materialTypeId: 'MAT-002' })).toBe(false);
  });

  it('stain floor is parent minus 1000', () => {
    expect(STAIN_FLOOR_DISCOUNT_NGN).toBe(1000);
    expect(stainFloorFromParentFloor(5000)).toBe(4000);
    expect(stainFloorFromParentFloor(0)).toBeNull();
    expect(applyStainFloorIfNeeded(5000, { materialTypeId: 'MAT-006' })).toBe(4000);
    expect(applyStainFloorIfNeeded(5000, { materialTypeId: 'MAT-002' })).toBe(5000);
  });

  it('looks up the parent workbook type for stain headers', () => {
    expect(
      stainWorkbookMaterialTypeId({ materialTypeId: 'MAT-006', stainSourceMaterialTypeId: 'MAT-002' })
    ).toBe('MAT-002');
    expect(stainWorkbookMaterialTypeId({ materialTypeId: 'MAT-001' })).toBe('MAT-001');
    expect(stainWorkbookMaterialTypeId({ materialTypeId: 'MAT-006' })).toBe('');
    expect(stainSourceMaterialTypeIdToDisplayName('MAT-001')).toBe('Aluminium');
    expect(stainSourceMaterialTypeIdToDisplayName('MAT-002')).toBe('Aluzinc');
    expect(stainSourceMaterialTypeIdToDisplayName('MAT-006')).toBe('');
  });

  it('matches coil_stain incidents to stain quote spec', () => {
    const inc = {
      incidentType: 'coil_stain',
      gaugeLabel: '0.45mm',
      colour: 'Traffic Black',
      materialFamily: 'aluzinc',
    };
    const quote = {
      materialGauge: '0.45mm',
      materialColor: 'Traffic Black',
      stainSourceMaterialTypeId: 'MAT-002',
    };
    expect(incidentMatchesStainQuoteSpec(inc, quote)).toBe(true);
    expect(incidentMatchesStainQuoteSpec({ ...inc, incidentType: 'yard_offcut' }, quote)).toBe(false);
    expect(incidentMatchesStainQuoteSpec({ ...inc, gaugeLabel: '0.32mm' }, quote)).toBe(false);
    expect(incidentFamilyMatchesStainSource('aluminium', 'MAT-001')).toBe(true);
    expect(incidentFamilyMatchesStainSource('aluzinc', 'MAT-001')).toBe(false);
    expect(incidentPoolKind('coil_stain')).toBe('stain');
    expect(incidentPoolKind('yard_offcut')).toBe('offcut');
  });

  it('matches stain pool rows to quotations', () => {
    const row = {
      poolKind: 'stain',
      metersAvailable: 40,
      gaugeLabel: '0.45mm',
      colour: 'Charcoal',
      materialFamily: 'aluzinc',
    };
    const q = {
      materialGauge: '0.45mm',
      materialColor: 'Charcoal',
      stainSourceMaterialTypeId: 'MAT-002',
    };
    expect(stainPoolRowMatchesQuotation(row, q)).toBe(true);
    expect(stainPoolRowMatchesQuotation({ ...row, poolKind: 'offcut' }, q)).toBe(false);
    expect(stainPoolRowMatchesQuotation({ ...row, metersAvailable: 0 }, q)).toBe(false);
  });

  it('builds trackable stain inventory lots from posted incidents', () => {
    const snap = buildStainInventorySnapshot([
      {
        id: 'MEX-1',
        incidentType: 'coil_stain',
        materialFamily: 'aluzinc',
        gaugeLabel: '0.45mm',
        colour: 'Charcoal',
        metersAvailable: 40,
        totalMeters: 50,
        kgDeducted: 100,
        coilNo: 'C-1',
      },
      {
        id: 'MEX-2',
        incidentType: 'yard_offcut',
        materialFamily: 'aluzinc',
        gaugeLabel: '0.45mm',
        colour: 'Charcoal',
        metersAvailable: 25,
      },
    ]);
    expect(snap.lots).toHaveLength(1);
    expect(snap.lots[0].materialType).toBe('Stain');
    expect(snap.lots[0].estMeters).toBe(40);
    expect(snap.lots[0].kg).toBeCloseTo(80, 5);
    expect(snap.lots[0].coilNo).toBe('C-1');
    expect(snap.totals.metersAvailable).toBe(40);
    expect(snap.bySpec).toHaveLength(1);
    expect(
      stockCheckRowsForMaterialType({
        coilRows: [{ materialType: 'Aluzinc', kg: 500 }],
        stainInventory: snap,
        materialTypeId: 'MAT-006',
      })
    ).toEqual(snap.lots);
    expect(
      stockCheckRowsForMaterialType({
        coilRows: [{ materialType: 'Aluzinc', kg: 500 }],
        stainInventory: snap,
        materialTypeId: 'MAT-002',
      })
    ).toEqual([{ materialType: 'Aluzinc', kg: 500 }]);
  });

  it('Type = Stone coated uses this-branch product SKUs, not coil lots', () => {
    const products = [
      {
        productID: 'STONE-bond-red-0.50mm',
        branchId: 'BR-YL',
        name: 'Stone coated Bond / Red / 0.50mm',
        stockLevel: 80,
        unit: 'm',
        dashboardAttrs: {
          inventoryModel: 'stone_meter',
          colour: 'Red',
          gauge: '0.50mm',
          materialType: 'Stone coated',
          stoneDesign: 'Bond',
        },
      },
      {
        productID: 'ACC-RIVET-PACK',
        branchId: 'BR-YL',
        name: 'Rivets',
        stockLevel: 12,
        unit: 'pack',
        dashboardAttrs: { inventoryModel: 'consumable' },
      },
    ];
    const rows = stockCheckRowsForMaterialType({
      coilRows: [{ materialType: 'Aluzinc', kg: 500 }],
      productRows: products,
      materialTypeId: 'MAT-005',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].productID).toBe('STONE-bond-red-0.50mm');
    expect(rows[0].estMeters).toBe(80);
    expect(rows[0].branchId).toBe('BR-YL');
    expect(stockCheckRowsFromStoneProducts(products)).toHaveLength(1);
  });
});
