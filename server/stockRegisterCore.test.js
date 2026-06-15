import { describe, expect, it } from 'vitest';
import {
  buildStockRegisterPack,
  coilMaterialFamily,
  colourFullNameForRegister,
  enrichStockRegisterValuation,
  netKgFromGrossClosing,
  periodBoundsFromEndDate,
} from '../shared/lib/stockRegisterCore.js';

describe('stockRegisterCore', () => {
  it('classifies aluminium and aluzinc', () => {
    expect(coilMaterialFamily('Aluminium')).toBe('aluminium');
    expect(coilMaterialFamily('Aluzinc')).toBe('aluzinc');
  });

  it('computes net kg with spool deduction for coils not rolls', () => {
    expect(netKgFromGrossClosing(1000, 'aluminium', 'coil')).toBe(965);
    expect(netKgFromGrossClosing(1000, 'aluzinc', 'coil')).toBe(940);
    expect(netKgFromGrossClosing(1000, 'aluminium', 'roll')).toBe(1000);
    expect(netKgFromGrossClosing(30, 'aluminium', 'coil')).toBe(0);
    expect(netKgFromGrossClosing(29, 'aluminium', 'coil')).toBe(29);
    expect(netKgFromGrossClosing(25, 'aluzinc', 'coil')).toBe(25);
  });

  it('builds coil register with opening received used closing', () => {
    const { start, end } = periodBoundsFromEndDate('2026-04-30');
    expect(start).toBe('2026-04-01');
    expect(end).toBe('2026-04-30');

    const pack = buildStockRegisterPack({
      branchId: 'BR-KD',
      periodEnd: end,
      masterData: { colours: [{ name: 'Premium Red', abbreviation: 'PRED' }] },
      prevClosingSnapshots: [{ coilNo: '2111', currentWeightKg: 2000 }],
      coilLots: [
        {
          coilNo: '2111',
          colour: 'Premium Red',
          gaugeLabel: '0.22mm',
          materialTypeName: 'Aluzinc',
          currentWeightKg: 1000,
          currentStatus: 'Available',
          stockForm: 'coil',
          receivedAtISO: '2026-01-15',
        },
        {
          coilNo: '2222',
          colour: 'NB',
          gaugeLabel: '0.22mm',
          materialTypeName: 'Aluzinc',
          weightKg: 1000,
          qtyReceived: 1000,
          currentWeightKg: 0,
          currentStatus: 'Consumed',
          stockForm: 'coil',
          receivedAtISO: '2026-04-05',
        },
      ],
      productionJobs: [
        {
          jobID: 'PJ-1',
          status: 'Completed',
          completedAtISO: '2026-04-20T10:00:00',
        },
      ],
      productionJobCoils: [
        { jobID: 'PJ-1', coilNo: '2111', consumedWeightKg: 1000 },
        { jobID: 'PJ-1', coilNo: '2222', consumedWeightKg: 1000 },
      ],
      coilControlEvents: [],
      products: [],
      stockMovements: [],
      inTransitLoads: [],
    });

    const aluz = pack.coilSections.aluzinc.groups.find((g) => g.gaugeLabel === '0.22mm');
    expect(aluz).toBeTruthy();
    const row2111 = aluz.rows.find((r) => r.coilNo === '2111');
    expect(row2111.openingKg).toBe(2000);
    expect(row2111.usedKg).toBe(1000);
    expect(row2111.closingKg).toBe(1000);

    const row2222 = aluz.rows.find((r) => r.coilNo === '2222');
    expect(row2222.receivedKg).toBeGreaterThan(0);
    expect(row2222.finishedInPeriod).toBe(true);
    expect(row2222.closingKg).toBeNull();
  });

  it('excludes negative or zero in-transit qty when received exceeds loaded', () => {
    const pack = buildStockRegisterPack({
      branchId: 'BR-KD',
      periodEnd: '2026-04-30',
      coilLots: [],
      products: [],
      stockMovements: [],
      inTransitLoads: [
        {
          status: 'in_transit',
          destinationBranchId: 'BR-KD',
          referenceNo: 'MT-1',
          lines: [{ itemName: 'Coil', qtyLoaded: 1000, qtyReceived: 1200, unit: 'kg' }],
        },
      ],
    });
    expect(pack.inTransit).toHaveLength(0);
  });

  it('values closing stock using fallback kg price when coil lines lack unit cost', () => {
    const pack = buildStockRegisterPack({
      branchId: 'BR-KD',
      periodEnd: '2026-04-30',
      prevClosingSnapshots: [{ coilNo: '3001', currentWeightKg: 500 }],
      coilLots: [
        {
          coilNo: '3001',
          colour: 'NB',
          gaugeLabel: '0.22mm',
          materialTypeName: 'Aluminium',
          currentWeightKg: 500,
          currentStatus: 'Available',
          stockForm: 'coil',
          receivedAtISO: '2026-01-01',
        },
      ],
      productionJobs: [],
      productionJobCoils: [],
      coilControlEvents: [],
      products: [],
      stockMovements: [],
      inTransitLoads: [],
    });
    enrichStockRegisterValuation(pack, {
      aluminiumUnitCostNgnPerKg: 1200,
      aluzincUnitCostNgnPerKg: 900,
      priceSources: { aluminium: 'purchase_31d', aluzinc: 'purchase_31d' },
    });
    expect(pack.summary.aluminium.unitCostNgnPerKg).toBe(1200);
    expect(pack.summary.aluminium.netClosingKg).toBe(465);
    expect(pack.summary.aluminium.valueNgn).toBe(465 * 1200);
  });

  it('shows full stone colour names and per-product accessory names', () => {
    const pack = buildStockRegisterPack({
      branchId: 'BR-KD',
      periodEnd: '2026-04-30',
      masterData: { colours: [{ name: 'Premium Red', abbreviation: 'PRED' }] },
      coilLots: [],
      productionJobs: [],
      productionJobCoils: [],
      coilControlEvents: [],
      stoneOpeningByProduct: new Map([['STONE-HMB-040', 100]]),
      products: [
        {
          productID: 'STONE-HMB-040',
          name: 'Stone HMB 0.40',
          stockLevel: 100,
          unit: 'm',
          dashboardAttrs: { gauge: '0.40mm', colour: 'PRED', stoneDesign: 'HMB' },
        },
        {
          productID: 'ACC-TAPPING-SCREW-PCS',
          name: 'Tapping Screw (50mm) — Box',
          stockLevel: 200,
          unit: 'pcs',
          dashboardAttrs: { inventoryModel: 'consumable' },
        },
      ],
      stockMovements: [],
      accessoryDisplayNameByProduct: new Map([
        ['ACC-TAPPING-SCREW-PCS', 'Tapping Screw 50mm (per PO wording)'],
      ]),
    });
    const stoneRow = pack.stoneCoated.groups[0]?.rows[0];
    expect(stoneRow.colourDisplay).toBe('Premium Red');
    expect(pack.accessories.rows).toHaveLength(1);
    expect(pack.accessories.rows[0].itemName).toBe('Tapping Screw 50mm (per PO wording)');
    expect(colourFullNameForRegister({ colours: [{ name: 'Premium Red', abbreviation: 'PRED' }] }, 'PRED')).toBe(
      'Premium Red'
    );
  });
});
