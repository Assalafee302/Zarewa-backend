import { describe, expect, it } from 'vitest';
import { coilStockTieOutRows, flattenMaterialTransactionCoilRows } from './coilStockTieOut.js';

describe('flattenMaterialTransactionCoilRows', () => {
  it('flattens coil rows out of the grouped material transaction report', () => {
    const report = {
      aluminium: {
        groups: [
          { gaugeLabel: '0.45mm', rows: [{ coilNo: 'CL-1', kgUsed: 30 }, { coilNo: 'CL-1', kgUsed: 10 }] },
        ],
      },
      aluzinc: { groups: [{ gaugeLabel: '0.5mm', rows: [{ coilNo: 'CL-2', kgUsed: 15 }] }] },
      unclassifiedCoil: { groups: [] },
    };
    const rows = flattenMaterialTransactionCoilRows(report);
    expect(rows).toEqual([
      { coilNo: 'CL-1', kgUsed: 30 },
      { coilNo: 'CL-1', kgUsed: 10 },
      { coilNo: 'CL-2', kgUsed: 15 },
    ]);
  });

  it('returns an empty array for a null report', () => {
    expect(flattenMaterialTransactionCoilRows(null)).toEqual([]);
  });
});

describe('coilStockTieOutRows', () => {
  it('flags a coil as ok when opening + purchased - consumed = closing', () => {
    const { rows, summary } = coilStockTieOutRows({
      openingSnapshotLots: [{ coilNo: 'CL-1', currentWeightKg: 100 }],
      closingSnapshotLots: [{ coilNo: 'CL-1', currentWeightKg: 70 }],
      coilLotsReceivedInPeriod: [],
      materialTransactionReport: {
        aluminium: { groups: [{ gaugeLabel: '0.45mm', rows: [{ coilNo: 'CL-1', kgUsed: 30 }] }] },
      },
      startDate: '2026-03-01',
      endDate: '2026-03-31',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('ok');
    expect(rows[0].varianceKg).toBe(0);
    expect(summary.mismatchCount).toBe(0);
  });

  it('flags a mismatch when the closing balance does not match opening + purchased - consumed', () => {
    const { rows, summary } = coilStockTieOutRows({
      openingSnapshotLots: [{ coilNo: 'CL-1', currentWeightKg: 100 }],
      closingSnapshotLots: [{ coilNo: 'CL-1', currentWeightKg: 50 }],
      materialTransactionReport: {
        aluminium: { groups: [{ gaugeLabel: '0.45mm', rows: [{ coilNo: 'CL-1', kgUsed: 30 }] }] },
      },
    });
    expect(rows[0].expectedClosingKg).toBe(70);
    expect(rows[0].closingKg).toBe(50);
    expect(rows[0].varianceKg).toBe(-20);
    expect(rows[0].status).toBe('mismatch');
    expect(summary.mismatchCount).toBe(1);
  });

  it('accounts for a coil purchased and partly consumed within the period', () => {
    const { rows } = coilStockTieOutRows({
      coilLotsReceivedInPeriod: [
        { coilNo: 'CL-9', receivedAtISO: '2026-03-05', productID: 'COIL-ALU', weightKg: 200, currentWeightKg: 200 },
      ],
      closingSnapshotLots: [{ coilNo: 'CL-9', currentWeightKg: 150 }],
      materialTransactionReport: {
        aluminium: { groups: [{ gaugeLabel: '0.5mm', rows: [{ coilNo: 'CL-9', kgUsed: 50 }] }] },
      },
      startDate: '2026-03-01',
      endDate: '2026-03-31',
    });
    expect(rows[0].openingKg).toBe(0);
    expect(rows[0].purchasedKg).toBe(200);
    expect(rows[0].consumedKg).toBe(50);
    expect(rows[0].expectedClosingKg).toBe(150);
    expect(rows[0].status).toBe('ok');
  });

  it('marks rows unverified rather than flagging false mismatches when no snapshot exists', () => {
    const { rows, summary } = coilStockTieOutRows({
      openingSnapshotLots: [],
      openingKnown: false,
      closingSnapshotLots: [{ coilNo: 'CL-1', currentWeightKg: 999 }],
      materialTransactionReport: {
        aluminium: { groups: [{ gaugeLabel: '0.45mm', rows: [{ coilNo: 'CL-1', kgUsed: 30 }] }] },
      },
    });
    expect(rows[0].status).toBe('unverified');
    expect(summary.mismatchCount).toBe(0);
    expect(summary.unverifiedCount).toBe(1);
  });
});
