import { describe, expect, it } from 'vitest';
import { buildPurchaseReport } from '../shared/lib/purchaseReportCore.js';

describe('buildPurchaseReport', () => {
  it('groups coil GRN by material and gauge with payment summary', () => {
    const report = buildPurchaseReport({
      purchaseOrders: [
        {
          poID: 'PO-1',
          supplierName: 'Alumaco',
          orderDateISO: '2026-05-01',
          status: 'Received',
          supplierPaidNgn: 500_000,
          procurementKind: 'coil',
          lines: [
            {
              lineKey: 'L1',
              productID: 'COIL-ALU',
              productName: 'Aluminium coil',
              gauge: '0.5mm',
              qtyOrdered: 1000,
              qtyReceived: 500,
              unitPricePerKgNgn: 2000,
            },
          ],
        },
      ],
      coilLots: [
        {
          coilNo: 'CL-26-0001',
          productID: 'COIL-ALU',
          lineKey: 'L1',
          poID: 'PO-1',
          supplierName: 'Alumaco',
          materialTypeName: 'Aluminium',
          gaugeLabel: '0.5mm',
          colour: 'IV',
          weightKg: 500,
          receivedAtISO: '2026-05-10',
          landedCostNgn: 1_000_000,
          unitCostNgnPerKg: 2000,
        },
      ],
      stockMovements: [],
      treasuryMovements: [],
      startDate: '2026-05-01',
      endDate: '2026-05-31',
    });

    expect(report.aluminium.groups).toHaveLength(1);
    expect(report.aluminium.groups[0].gaugeLabel).toBe('0.5mm');
    expect(report.aluminium.groups[0].rows[0].receivedKg).toBe(500);
    expect(report.aluminium.groups[0].rows[0].orderKg).toBe(1000);
    expect(report.summary.byMaterial.some((m) => m.label === 'Aluminium')).toBe(true);
    expect(report.payments.poBalances).toHaveLength(1);
    expect(report.payments.poBalances[0].outstandingNgn).toBe(1_500_000);
  });

  it('includes stone GRN from stock movements', () => {
    const report = buildPurchaseReport({
      purchaseOrders: [
        {
          poID: 'PO-ST',
          supplierName: 'Stone Co',
          supplierPaidNgn: 0,
          lines: [
            {
              lineKey: 'L1',
              productID: 'STONE-M-01',
              productName: 'Stone metre',
              gauge: '0.4mm',
              qtyOrdered: 200,
              qtyReceived: 100,
              unitPriceNgn: 5000,
            },
          ],
        },
      ],
      coilLots: [],
      stockMovements: [
        {
          type: 'STORE_GRN_STONE',
          ref: 'PO-ST',
          productID: 'STONE-M-01',
          qty: 100,
          dateISO: '2026-05-12',
          unitPriceNgn: 5000,
          valueNgn: 500_000,
          detail: 'ST-PO-ST-L1 · 100 m · main store',
        },
      ],
      treasuryMovements: [],
      products: [{ productID: 'STONE-M-01', name: 'Stone metre', dashboardAttrs: { gauge: '0.4mm' } }],
      startDate: '2026-05-01',
      endDate: '2026-05-31',
    });
    expect(report.stoneCoated.groups[0].rows[0].receivedQty).toBe(100);
    expect(report.summary.byMaterial.some((m) => m.key === 'stone')).toBe(true);
  });
});
