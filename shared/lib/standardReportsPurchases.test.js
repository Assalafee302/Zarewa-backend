import { describe, expect, it } from 'vitest';
import { purchasesOrderedRows, purchasesPaidRows, purchasesReceivedRows } from './standardReportsPurchases.js';

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

describe('purchasesPaidRows', () => {
  it('shows a bank short code for bank payments and "Cash" for till payments', () => {
    const rows = purchasesPaidRows(
      [
        {
          type: 'SUPPLIER_PAYMENT',
          counterpartyKind: 'SUPPLIER',
          counterpartyName: 'Sup A',
          postedAtISO: '2026-06-05',
          amountNgn: 100000,
          accountType: 'Bank',
          accountName: 'GTBank Main',
          bankName: 'Guaranty Trust Bank',
        },
        {
          type: 'PO_SUPPLIER_PAYMENT',
          counterpartyKind: 'SUPPLIER',
          counterpartyName: 'Sup B',
          postedAtISO: '2026-06-06',
          amountNgn: 50000,
          accountType: 'Cash',
          accountName: 'Cash Office (Till)',
        },
      ],
      '2026-06-01',
      '2026-06-30'
    );
    expect(rows).toHaveLength(2);
    expect(rows[0].paymentMethod).toBe('Bank');
    expect(rows[0].bankAccount).toBe('GTB');
    expect(rows[1].paymentMethod).toBe('Cash');
    expect(rows[1].bankAccount).toBe('Cash');
  });
});
