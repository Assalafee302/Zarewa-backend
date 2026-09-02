import { describe, expect, it } from 'vitest';
import { stockCoilAsAtRows, stockCoilAsAtTotals } from './standardReportsStock.js';

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
