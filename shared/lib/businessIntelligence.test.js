import { describe, expect, it } from 'vitest';
import {
  buildBusinessIntelligencePack,
  computeInventoryAnalytics,
  computeSalesAnalytics,
  resolveBusinessMaterialFamily,
  topCustomersByNetPayments,
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
        productionJobs: [
          {
            status: 'Completed',
            quotationRef: 'QT-1',
            productID: 'COIL-ALU',
            actualWeightKg: 200,
            completedAtISO: '2026-05-12T10:00:00Z',
          },
        ],
        quotations: [{ id: 'QT-1', materialTypeId: 'MAT-001' }],
      },
      { periodKey: 'month', asOfISO: '2026-05-20' }
    );
    expect(inv.families[0].kgOnHand).toBe(1000);
    expect(inv.families[1].kgOnHand).toBe(500);
    expect(inv.totalCoilKg).toBe(1500);
  });

  it('ranks top customers by net payments minus refunds', () => {
    const rows = topCustomersByNetPayments(
      [
        {
          customerID: 'C1',
          customer: 'Alpha Ltd',
          dateISO: '2026-05-10',
          amountNgn: 500000,
        },
        {
          customerID: 'C2',
          customer: 'Beta Co',
          dateISO: '2026-05-12',
          amountNgn: 300000,
        },
      ],
      [
        {
          customerID: 'C1',
          customer: 'Alpha Ltd',
          requestedAtISO: '2026-05-15',
          status: 'Paid',
          paidAmountNgn: 50000,
        },
      ],
      '2026-05-01',
      '2026-05-31',
      5
    );
    expect(rows[0].customerID).toBe('C1');
    expect(rows[0].paymentsNgn).toBe(500000);
    expect(rows[0].refundsNgn).toBe(50000);
    expect(rows[0].netCollectedNgn).toBe(450000);
    expect(rows[1].netCollectedNgn).toBe(300000);
  });

  it('includes material performance and sku intelligence in pack', () => {
    const pack = buildBusinessIntelligencePack(
      {
        quotations: [
          {
            id: 'QT-1',
            customerID: 'C1',
            customer: 'Acme',
            dateISO: '2026-05-10',
            totalNgn: 100000,
            materialGauge: '0.26mm',
            materialColor: 'IV',
            materialDesign: 'Corrugated',
            materialTypeId: 'MAT-001',
          },
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
        receipts: [{ customerID: 'C1', customer: 'Acme', dateISO: '2026-05-16', amountNgn: 80000 }],
        ledgerEntries: [],
        refunds: [],
        coilLots: [
          {
            currentStatus: 'Available',
            materialTypeName: 'Aluminium',
            currentWeightKg: 1000,
            gaugeLabel: '0.26mm',
            colour: 'IV',
            unitCostNgnPerKg: 300,
          },
        ],
        products: [],
        stockMovements: [],
        purchaseOrders: [
          {
            supplierID: 'S1',
            supplierName: 'Coil Vendor',
            status: 'Open',
            orderDateISO: '2026-05-01',
            lines: [{ productID: 'COIL-ALU', qtyOrdered: 500, qtyReceived: 0, unitPricePerKgNgn: 1100 }],
          },
        ],
        expenses: [],
        treasuryMovements: [],
        paymentRequests: [],
        treasuryAccounts: [{ balance: 5000 }],
      },
      { periodKey: 'month', asOfISO: '2026-05-20' }
    );
    expect(pack.sales.materialPerformance?.aluminium?.topCombinations?.length).toBeGreaterThan(0);
    expect(pack.inventory.skuIntelligence?.aluminium).toBeTruthy();
    expect(pack.procurement?.supplierFocus?.length).toBeGreaterThan(0);
    expect(pack.sales.topCustomers[0].netCollectedNgn).toBe(80000);
    const combo = pack.sales.materialPerformance?.aluminium?.topCombinations?.[0];
    expect(combo?.revenueNgn).toBeGreaterThan(0);
    expect(combo?.cogsNgn).toBeGreaterThan(0);
    expect(combo?.marginNgn).toBeDefined();
    expect(combo?.marginPct).toBeGreaterThan(0);
    expect(pack.productionForecast?.horizons?.length).toBe(3);
    expect(pack.inventoryForecast?.familyForecasts?.length).toBeGreaterThan(0);
  });

  it('computes expense analysis and production forecast', () => {
    const pack = buildBusinessIntelligencePack(
      {
        quotations: [{ id: 'Q1', dateISO: '2026-05-10', totalNgn: 200000 }],
        productionJobs: [
          {
            status: 'Completed',
            quotationRef: 'Q1',
            productID: 'COIL-ALU',
            actualMeters: 50,
            completedAtISO: '2026-05-15T10:00:00Z',
          },
        ],
        cuttingLists: [],
        receipts: [],
        ledgerEntries: [],
        refunds: [],
        coilLots: [],
        products: [],
        stockMovements: [],
        purchaseOrders: [],
        expenses: [
          { expenseID: 'E1', category: 'Diesel', amountNgn: 50000, date: '2026-05-12', branchId: 'BR-KD' },
          { expenseID: 'E2', category: 'Transport', amountNgn: 20000, date: '2026-05-08', branchId: 'BR-KD' },
        ],
        treasuryMovements: [],
        paymentRequests: [],
        treasuryAccounts: [],
      },
      { periodKey: 'month', asOfISO: '2026-05-20' }
    );
    expect(pack.expenseAnalysis.periodTotalNgn).toBe(70000);
    expect(pack.expenseAnalysis.topCategories[0].category).toBe('Diesel');
    expect(pack.productionForecast.horizons[0].projectedProducedRevenueNgn).toBeGreaterThanOrEqual(0);
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

  it('merges Metra and Industrial 6 profiles and ranks material combos by metres', () => {
    const pack = buildBusinessIntelligencePack(
      {
        quotations: [
          {
            id: 'QT-M',
            dateISO: '2026-05-10',
            totalNgn: 50000,
            materialGauge: '0.26mm',
            materialColor: 'IV',
            materialDesign: 'Longspan (Metra)',
            materialTypeId: 'MAT-001',
          },
          {
            id: 'QT-I',
            dateISO: '2026-05-10',
            totalNgn: 50000,
            materialGauge: '0.26mm',
            materialColor: 'IV',
            materialDesign: 'Longspan (Indus6)',
            materialTypeId: 'MAT-001',
          },
          {
            id: 'QT-C',
            dateISO: '2026-05-10',
            totalNgn: 200000,
            materialGauge: '0.26mm',
            materialColor: 'IV',
            materialDesign: 'Corrugated',
            materialTypeId: 'MAT-001',
          },
        ],
        productionJobs: [
          {
            status: 'Completed',
            quotationRef: 'QT-M',
            productID: 'COIL-ALU',
            actualMeters: 40,
            completedAtISO: '2026-05-15T10:00:00Z',
          },
          {
            status: 'Completed',
            quotationRef: 'QT-I',
            productID: 'COIL-ALU',
            actualMeters: 60,
            completedAtISO: '2026-05-16T10:00:00Z',
          },
          {
            status: 'Completed',
            quotationRef: 'QT-C',
            productID: 'COIL-ALU',
            actualMeters: 30,
            completedAtISO: '2026-05-17T10:00:00Z',
          },
        ],
        cuttingLists: [],
        receipts: [],
        ledgerEntries: [],
        refunds: [],
        coilLots: [],
        products: [],
        stockMovements: [],
        purchaseOrders: [],
        expenses: [],
        treasuryMovements: [],
        paymentRequests: [],
        treasuryAccounts: [],
      },
      { periodKey: 'month', asOfISO: '2026-05-20' }
    );
    const combos = pack.sales.materialPerformance?.aluminium?.topCombinations || [];
    const longspan = combos.find((c) => c.profile === 'Longspan (Industrial 6 & Metra)');
    expect(longspan?.metres).toBe(100);
    expect(combos[0].profile).toBe('Longspan (Industrial 6 & Metra)');
    expect(combos[0].metres).toBeGreaterThan(combos[1]?.metres || 0);
  });

  it('counts receivables only when production is complete with balance due', () => {
    const pack = buildBusinessIntelligencePack(
      {
        quotations: [
          { id: 'QT-UNPAID', dateISO: '2026-05-10', totalNgn: 200_000, paidNgn: 0 },
          { id: 'QT-AR', dateISO: '2026-05-10', totalNgn: 100_000, paidNgn: 30_000 },
        ],
        productionJobs: [
          {
            status: 'Completed',
            quotationRef: 'QT-AR',
            productID: 'COIL-ALU',
            actualMeters: 20,
            completedAtISO: '2026-05-15T10:00:00Z',
          },
        ],
        cuttingLists: [],
        receipts: [],
        ledgerEntries: [],
        refunds: [],
        coilLots: [],
        products: [],
        stockMovements: [],
        purchaseOrders: [],
        expenses: [],
        treasuryMovements: [],
        paymentRequests: [],
        treasuryAccounts: [],
      },
      { periodKey: 'month', asOfISO: '2026-05-20' }
    );
    expect(pack.sales.outstandingReceivablesNgn).toBe(70_000);
  });
});
