import { describe, expect, it } from 'vitest';
import {
  buildStockRegisterPack,
  coilMaterialFamily,
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
});
