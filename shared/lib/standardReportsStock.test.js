import { describe, expect, it } from 'vitest';
import { stockCoilAsAtRows } from './standardReportsStock.js';

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
  });
});
