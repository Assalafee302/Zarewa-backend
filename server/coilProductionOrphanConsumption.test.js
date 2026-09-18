import { describe, expect, it } from 'vitest';
import {
  coilProductionJobConsumedKgFromMovements,
  listOrphanCoilProductionHolders,
  stockMovementDetailRefersToCoilNo,
} from './productionTraceability.js';

function fakeDb({ movements = [], jobs = {}, conversionChecks = [], cuttingLists = {} }) {
  return {
    prepare(sql) {
      const s = String(sql);
      return {
        all() {
          if (s.includes("type = 'COIL_CONSUMPTION'")) return movements;
          if (s.includes('FROM production_conversion_checks')) return conversionChecks;
          return [];
        },
        get(...args) {
          if (s.includes('FROM production_jobs')) return jobs[args[0]] || null;
          if (s.includes('FROM cutting_lists')) return cuttingLists[args[0]] || null;
          return undefined;
        },
      };
    },
  };
}

const coil8405Moves = [
  {
    qty: -18,
    detail: '8405 consumed for 9.50 m on PRO-YL-26-0071',
    ref: 'PRO-YL-26-0071',
    at_iso: '2026-09-15T12:00:00',
  },
  {
    qty: -500,
    detail: '8405 consumed for 226.40 m on PRO-YL-26-0110',
    ref: 'PRO-YL-26-0110',
    at_iso: '2026-09-18T12:00:00',
  },
  {
    qty: 500,
    detail: 'Completion coil correction — restore 500.00 kg to 8405 (PRO-YL-26-0110)',
    ref: 'PRO-YL-26-0110',
    at_iso: '2026-09-18T17:22:00',
  },
  {
    qty: -500,
    detail: '8405 consumed for 226.40 m on PRO-YL-26-0110 (completion correction)',
    ref: 'PRO-YL-26-0110',
    at_iso: '2026-09-18T17:22:00',
  },
];

describe('coilProductionJobConsumedKgFromMovements', () => {
  it('keeps orphan job consumption after a completion-correction restore/re-consume pair', () => {
    const db = fakeDb({ movements: coil8405Moves });
    expect(coilProductionJobConsumedKgFromMovements(db, '8405')).toBeCloseTo(518, 2);
  });

  it('does not count finish-roll tails as job consumption', () => {
    const db = fakeDb({
      movements: [
        {
          qty: -72,
          detail: 'CL-26-2040 roll finished — tail 72.00 kg removed from yard stock (PRO-1)',
          ref: 'PRO-1',
          at_iso: '2026-07-09T12:00:00',
        },
        {
          qty: -3468,
          detail: 'CL-26-2040 consumed for 114.00 m on PRO-1',
          ref: 'PRO-1',
          at_iso: '2026-07-09T12:00:00',
        },
      ],
    });
    expect(coilProductionJobConsumedKgFromMovements(db, 'CL-26-2040')).toBeCloseTo(3468, 2);
  });

  it('does not pick up a different coil whose number contains this coil as a substring', () => {
    const db = fakeDb({
      movements: [
        {
          qty: -18,
          detail: '18405 consumed for 9.50 m on PRO-1',
          ref: 'PRO-1',
          at_iso: '2026-09-15T12:00:00',
        },
      ],
    });
    expect(coilProductionJobConsumedKgFromMovements(db, '8405')).toBe(0);
    expect(stockMovementDetailRefersToCoilNo('18405 consumed for 9.50 m on PRO-1', '8405')).toBe(false);
  });
});

describe('listOrphanCoilProductionHolders', () => {
  it('surfaces a completed job that still has consumption on the ledger but no allocation row', () => {
    const db = fakeDb({
      movements: coil8405Moves,
      jobs: {
        'PRO-YL-26-0071': {
          job_id: 'PRO-YL-26-0071',
          status: 'Completed',
          cutting_list_id: 'CL-YL-26-0051',
          quotation_ref: 'QT-YL-26-0071',
        },
      },
      conversionChecks: [
        {
          job_id: 'PRO-YL-26-0071',
          alert_state: 'Low',
          actual_conversion_kg_per_m: 1.89,
          checked_at_iso: '2026-09-15T12:00:00',
        },
      ],
      cuttingLists: {
        'CL-YL-26-0051': { customer_name: 'tijjani Nuru' },
      },
    });
    const liveHolders = [{ jobID: 'PRO-YL-26-0110', consumedWeightKg: 500 }];
    const orphans = listOrphanCoilProductionHolders(db, '8405', liveHolders);
    expect(orphans).toHaveLength(1);
    expect(orphans[0].jobID).toBe('PRO-YL-26-0071');
    expect(orphans[0].orphanedFromLedger).toBe(true);
    expect(orphans[0].consumedWeightKg).toBeCloseTo(18, 2);
    expect(orphans[0].metersProduced).toBeCloseTo(9.5, 2);
    expect(orphans[0].cuttingListId).toBe('CL-YL-26-0051');
    expect(orphans[0].conversionAlertState).toBe('Low');
  });
});
