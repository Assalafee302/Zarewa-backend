import { describe, expect, it } from 'vitest';
import { buildSupplierCoilReceiptVariance } from './supplierCoilReceiptVariance.js';

describe('buildSupplierCoilReceiptVariance', () => {
  it('reports weighbridge kg short of purchased kg even when the PO line was snapped closed', () => {
    const result = buildSupplierCoilReceiptVariance({
      supplierId: 'SUP-1',
      purchaseOrders: [
        {
          poID: 'PO-1',
          supplierID: 'SUP-1',
          status: 'Received',
          lines: [
            {
              lineType: 'coil_kg',
              productID: 'COIL-ALU',
              qtyOrdered: 5000,
              qtyReceived: 5000,
            },
          ],
        },
      ],
      coilLots: [{ poID: 'PO-1', supplierID: 'SUP-1', weightKg: 4800, qtyReceived: 4800 }],
    });
    expect(result.orderedKg).toBe(5000);
    expect(result.landedKg).toBe(4800);
    expect(result.shortKg).toBe(200);
    expect(result.shortPoCount).toBe(1);
    expect(result.fulfillmentPct).toBe(96);
    expect(result.shortPos[0].poID).toBe('PO-1');
  });

  it('does not treat unreceived POs as a supplier shortfall', () => {
    const result = buildSupplierCoilReceiptVariance({
      supplierId: 'SUP-1',
      purchaseOrders: [
        {
          poID: 'PO-OPEN',
          supplierID: 'SUP-1',
          status: 'In Transit',
          lines: [{ lineType: 'coil_kg', productID: 'COIL-ALU', qtyOrdered: 3000, qtyReceived: 0 }],
        },
      ],
      coilLots: [],
    });
    expect(result.orderedKg).toBe(3000);
    expect(result.landedKg).toBe(0);
    expect(result.shortKg).toBe(0);
    expect(result.shortPoCount).toBe(0);
  });
});
