import { describe, expect, it } from 'vitest';
import { purchasesOrderedRows, purchasesReceivedRows } from './standardReportsPurchases.js';

describe('purchasesReceivedRows', () => {
  it('filters by received date', () => {
    const rows = purchasesReceivedRows(
      [
        {
          receivedAtISO: '2026-06-01',
          coilNo: 'CL-99',
          productID: 'COIL-ALU',
          weightKg: 10,
          currentWeightKg: 10,
          colour: 'R',
          gaugeLabel: '0.5',
          supplierName: 'S',
          poID: 'PO-1',
          unitCostNgnPerKg: 100,
          materialTypeName: 'Alu',
        },
        { receivedAtISO: '2025-01-01', coilNo: 'X', productID: 'COIL-ALU', currentWeightKg: 1 },
      ],
      '2026-05-01',
      '2026-06-30'
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].coilNoDisplay).toBe('99');
  });
});

describe('purchasesOrderedRows', () => {
  it('skips accessory-only POs', () => {
    const rows = purchasesOrderedRows(
      [
        {
          poID: 'PO-A',
          orderDateISO: '2026-04-10',
          supplierName: 'Sup',
          status: 'Open',
          supplierPaidNgn: 0,
          procurementKind: 'accessory',
          lines: [{ productID: 'ACC-1', productName: 'Screw', qtyOrdered: 10, unitPriceNgn: 50 }],
        },
      ],
      '2026-04-01',
      '2026-04-30'
    );
    expect(rows).toHaveLength(0);
  });
});
