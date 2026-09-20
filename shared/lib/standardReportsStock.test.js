import { describe, expect, it } from 'vitest';
import { stockCoilAsAtRows, stockCoilAsAtTotals, stockStainInventoryRows, stockStainInventoryTotals, stockStoneAsAtRows, stockStoneAsAtTotals, stockAccessoryAsAtRows, stockAccessoryAsAtTotals } from './standardReportsStock.js';

describe('stockCoilAsAtRows', () => {
  it('maps coil lots to dense display fields', () => {
    const rows = stockCoilAsAtRows([
      {
        coilNo: 'CL-99',
        colour: 'IV',
        gaugeLabel: '0.5mm',
        materialTypeName: 'Aluminium',
        currentWeightKg: 123.456,
        poID: 'PO-99',
        supplierName: 'Alumaco',
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].coilNoDisplay).toBe('99');
    expect(rows[0].balanceKg).toBe(123.46);
    expect(rows[0].matGaugeKey).toBe('Aluminium|0.5mm');
    expect(rows[0].supplier).toBe('Alumaco');
    expect(rows[0].valueNgn).toBeNull();
  });

  it('values a coil from its landed cost when available', () => {
    const rows = stockCoilAsAtRows([
      { coilNo: 'CL-1', currentWeightKg: 100, landedCostNgn: 250000, unitCostNgnPerKg: 2400 },
    ]);
    expect(rows[0].valueNgn).toBe(250000);
  });

  it('falls back to unit cost x weight when no landed cost is on record', () => {
    const rows = stockCoilAsAtRows([{ coilNo: 'CL-2', currentWeightKg: 50, unitCostNgnPerKg: 2000 }]);
    expect(rows[0].valueNgn).toBe(100000);
  });
});

describe('stockCoilAsAtTotals', () => {
  it('sums valued rows and flags rows with no cost on record', () => {
    const rows = stockCoilAsAtRows([
      { coilNo: 'CL-1', currentWeightKg: 100, unitCostNgnPerKg: 1000 },
      { coilNo: 'CL-2', currentWeightKg: 50 },
    ]);
    const totals = stockCoilAsAtTotals(rows);
    expect(totals.totalValueNgn).toBe(100000);
    expect(totals.valuedRowCount).toBe(1);
    expect(totals.unvaluedRowCount).toBe(1);
  });
});

describe('stockStainInventoryRows', () => {
  it('maps remaining stain lots to report rows', () => {
    const rows = stockStainInventoryRows([
      {
        id: 'MEX-1',
        coilNo: 'CL-88',
        colour: 'Charcoal',
        gaugeLabel: '0.45mm',
        sourceMaterialTypeName: 'Aluzinc',
        metersAvailable: 40.125,
        kgBooked: 80.4,
      },
    ]);
    expect(rows[0].materialType).toBe('Stain');
    expect(rows[0].sourceMaterialType).toBe('Aluzinc');
    expect(rows[0].balanceMeters).toBe(40.13);
    expect(rows[0].coilNoDisplay).toBe('88');
    const totals = stockStainInventoryTotals(rows);
    expect(totals.lotCount).toBe(1);
    expect(totals.totalMeters).toBe(40.13);
    expect(totals.totalKg).toBe(80.4);
  });
});

describe('stockStoneAsAtRows', () => {
  it('keeps Kaduna and Yola balances on separate rows for the same SKU id', () => {
    const rows = stockStoneAsAtRows([
      {
        productID: 'STONE-bond-red-0.50mm',
        branchId: 'BR-KD',
        name: 'Stone coated Bond / Red / 0.50mm',
        stockLevel: 120,
        unit: 'm',
        dashboardAttrs: { inventoryModel: 'stone_meter', colour: 'Red', gauge: '0.50mm' },
      },
      {
        productID: 'STONE-bond-red-0.50mm',
        branchId: 'BR-YL',
        name: 'Stone coated Bond / Red / 0.50mm',
        stockLevel: 15,
        unit: 'm',
        dashboardAttrs: { inventoryModel: 'stone_meter', colour: 'Red', gauge: '0.50mm' },
      },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.branchId === 'BR-KD')?.balanceMeters).toBe(120);
    expect(rows.find((r) => r.branchId === 'BR-YL')?.balanceMeters).toBe(15);
    expect(stockStoneAsAtTotals(rows).totalMeters).toBe(135);
  });
});

describe('stockAccessoryAsAtRows', () => {
  it('does not merge accessory qty across branches', () => {
    const rows = stockAccessoryAsAtRows([
      { productID: 'ACC-RIVET-PACK', branchId: 'BR-KD', name: 'Rivets', stockLevel: 50, unit: 'pack' },
      { productID: 'ACC-RIVET-PACK', branchId: 'BR-YL', name: 'Rivets', stockLevel: 3, unit: 'pack' },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.branchId === 'BR-YL')?.balance).toBe(3);
    expect(stockAccessoryAsAtTotals(rows).totalBalance).toBe(53);
  });
});
