import { describe, it, expect } from 'vitest';
import {
  computeCuttingListMaterialReadiness,
  formatNoCoilMatchAlertForCuttingList,
  formatNoStainPoolMatchAlertForCuttingList,
} from './salesCuttingListMaterialReadiness.js';

describe('salesCuttingListMaterialReadiness', () => {
  it('formats no-match alert with list id and quote material fields', () => {
    const cl = { id: 'CL-0006', customer: 'Acme' };
    const q = {
      materialColor: 'Heritage Blue',
      materialGauge: '0.45mm',
      materialTypeName: 'Aluzinc longspan',
    };
    expect(formatNoCoilMatchAlertForCuttingList(cl, q)).toBe(
      'CL-0006 does not have a coil match for colour Heritage Blue, gauge 0.45mm, material Aluzinc longspan.'
    );
  });

  it('readiness for stain quotes uses stain pool metres or matching coils', () => {
    const cl = { id: 'CL-STAIN-1', quotationRef: 'QT-STAIN-1', totalMeters: 20, status: 'Waiting' };
    const q = {
      id: 'QT-STAIN-1',
      materialTypeId: 'MAT-006',
      materialGauge: '0.45mm',
      materialColor: 'Charcoal',
      stainSourceMaterialTypeId: 'MAT-002',
    };
    const none = computeCuttingListMaterialReadiness(
      [cl],
      [q],
      [{ kg: 500, gaugeLabel: '0.32mm', colour: 'Traffic Black', materialType: 'Aluminium' }],
      null,
      []
    );
    expect(none.waitingWithSpecNoStock).toBe(1);
    expect(none.waitingNoMatch[0].alertText).toBe(
      formatNoStainPoolMatchAlertForCuttingList(cl, q)
    );

    const readyPool = computeCuttingListMaterialReadiness(
      [cl],
      [q],
      [],
      null,
      [
        {
          poolKind: 'stain',
          metersAvailable: 40,
          gaugeLabel: '0.45mm',
          colour: 'Charcoal',
          materialFamily: 'aluzinc',
        },
      ]
    );
    expect(readyPool.ready).toHaveLength(1);
    expect(readyPool.ready[0].totalEstM).toBe(40);
    expect(readyPool.waitingWithSpecNoStock).toBe(0);

    const readyCoil = computeCuttingListMaterialReadiness(
      [cl],
      [q],
      [{ kg: 800, estMeters: 50, gaugeLabel: '0.45mm', colour: 'Charcoal', materialType: 'Aluzinc' }],
      null,
      []
    );
    expect(readyCoil.ready).toHaveLength(1);
    expect(readyCoil.ready[0].totalKg).toBe(800);
    expect(readyCoil.ready[0].totalEstM).toBe(50);
    expect(readyCoil.waitingWithSpecNoStock).toBe(0);
  });
});
