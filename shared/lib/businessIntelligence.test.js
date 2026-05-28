import { describe, expect, it } from 'vitest';
import {
  buildBusinessIntelligencePack,
  computeInventoryAnalytics,
  computeSalesAnalytics,
  resolveBusinessMaterialFamily,
} from './businessIntelligence.js';

describe('businessIntelligence', () => {
  it('resolves aluminium vs aluzinc from product ids', () => {
    expect(resolveBusinessMaterialFamily({ productID: 'COIL-ALU' })).toBe('aluminium');
    expect(resolveBusinessMaterialFamily({ productID: 'PRD-102' })).toBe('aluzinc');
    expect(resolveBusinessMaterialFamily({ materialTypeId: 'MAT-002' })).toBe('aluzinc');
  });

  it('builds sales mix from completed production jobs', () => {
    const sales = computeSalesAnalytics(
      {
        quotations: [
          { id: 'QT-1', customerID: 'C1', customer: 'Acme', dateISO: '2026-05-10', totalNgn: 100000 },
        ],
        productionJobs: [
          {
            status: 'Completed',
            quotationRef: 'QT-1',
            productID: 'COIL-ALU',
            actualMeters: 100,
            actualWeightKg: 250,
            completedAtISO: '2026-05-15T10:00:00Z',
          },
        ],
        cuttingLists: [],
        receipts: [],
        ledgerEntries: [],
      },
      { periodKey: 'month', asOfISO: '2026-05-20' }
    );
    expect(sales.producedRevenueNgn).toBe(100000);
    const alu = sales.mixRows.find((r) => r.family === 'aluminium');
    expect(alu?.revenueNgn).toBe(100000);
  });

  it('computes coil family inventory and cover weeks', () => {
    const inv = computeInventoryAnalytics(
      {
        coilLots: [
          {
            currentStatus: 'Available',
            materialTypeName: 'Aluminium',
            currentWeightKg: 1000,
            gaugeLabel: '0.26mm',
            colour: 'IV',
          },
          {
            currentStatus: 'Available',
            materialTypeName: 'Aluzinc (PPGI)',
            currentWeightKg: 500,
            gaugeLabel: '0.28mm',
            colour: 'TB',
          },
        ],
        products: [
          { productID: 'COIL-ALU', stockLevel: 1000, unit: 'kg' },
          { productID: 'PRD-102', stockLevel: 500, unit: 'kg' },
        ],
        stockMovements: [
          {
            type: 'COIL_CONSUMPTION',
            productID: 'COIL-ALU',
            qty: 300,
            atISO: '2026-05-10T00:00:00Z',
          },
        ],
        purchaseOrders: [],
        productionJobs: [],
        quotations: [],
      },
      { periodKey: 'month', asOfISO: '2026-05-20' }
    );
    expect(inv.families[0].kgOnHand).toBe(1000);
    expect(inv.families[1].kgOnHand).toBe(500);
    expect(inv.totalCoilKg).toBe(1500);
  });

  it('builds full pack with predictive alerts', () => {
    const pack = buildBusinessIntelligencePack(
      {
        quotations: [{ id: 'Q1', dateISO: '2026-05-01', totalNgn: 50000, paidNgn: 0, customerID: 'C1' }],
        productionJobs: [],
        cuttingLists: [],
        receipts: [],
        ledgerEntries: [],
        refunds: [],
        coilLots: [],
        products: [],
        stockMovements: [],
        purchaseOrders: [],
        expenses: [],
        treasuryMovements: [{ amountNgn: -10000, postedAtISO: '2026-05-05', type: 'EXPENSE_PAYOUT' }],
        paymentRequests: [],
        treasuryAccounts: [{ balance: 5000 }],
      },
      { periodKey: 'month', asOfISO: '2026-05-20', branchScope: 'BR-KD' }
    );
    expect(pack.ok).toBe(true);
    expect(pack.branchScope).toBe('BR-KD');
    expect(pack.predictive).toBeTruthy();
    expect(Array.isArray(pack.predictive.alerts)).toBe(true);
  });
});
