import { describe, it, expect } from 'vitest';
import {
  coilProducedMetersFromProductionJobs,
  jobActualMetersFromProductionJobs,
  jobEffectiveOutputMetresForRefund,
  jobOutputMetresForUnproducedRefund,
  producedMetersForUnproducedRefund,
} from './refundCoilProducedMeters.js';

function memDbWithCoils(coilRows = [], fgAdjByJob = {}) {
  return {
    prepare(sql) {
      const s = String(sql);
      return {
        get(jobId) {
          if (s.includes('FROM production_job_coils') && s.includes('SUM')) {
            const jid = String(jobId ?? '').trim();
            const sum = coilRows
              .filter((c) => String(c.job_id || '').trim() === jid)
              .reduce((acc, c) => acc + (Number(c.meters_produced) || 0), 0);
            return { s: sum };
          }
          if (s.includes('FROM production_completion_adjustments')) {
            const jid = String(jobId ?? '').trim();
            return { s: Number(fgAdjByJob[jid]) || 0 };
          }
          return undefined;
        },
      };
    },
  };
}

describe('refundCoilProducedMeters', () => {
  it('returns 0 when jobs have no coil allocation rows', () => {
    const db = memDbWithCoils([]);
    const jobs = [{ job_id: 'PRO-OFF', actual_meters: 100, offcut_inventory_meters: 100 }];
    expect(coilProducedMetersFromProductionJobs(db, jobs)).toBe(0);
  });

  it('sums meters_produced from coil allocations only', () => {
    const db = memDbWithCoils([
      { job_id: 'PRO-1', meters_produced: 40 },
      { job_id: 'PRO-1', meters_produced: 10 },
      { job_id: 'PRO-2', meters_produced: 25 },
    ]);
    expect(
      coilProducedMetersFromProductionJobs(db, [{ job_id: 'PRO-1' }, { job_id: 'PRO-2' }])
    ).toBe(75);
  });

  it('ignores offcut FG actual_meters on the job row', () => {
    const db = memDbWithCoils([]);
    expect(
      coilProducedMetersFromProductionJobs(db, [
        { job_id: 'PRO-OFF', actual_meters: 100, offcut_inventory_meters: 100 },
      ])
    ).toBe(0);
  });

  it('jobActualMetersFromProductionJobs sums completed job actual metres only', () => {
    expect(
      jobActualMetersFromProductionJobs([
        { status: 'Completed', actual_meters: 28 },
        { status: 'Planned', actual_meters: 40 },
        { status: 'Cancelled', actual_meters: 5 },
      ])
    ).toBe(28);
  });

  it('producedMetersForUnproducedRefund uses job actuals on stone meter quotes', () => {
    const db = memDbWithCoils([]);
    const jobs = [{ job_id: 'PRO-ST', status: 'Completed', actual_meters: 28, planned_meters: 40 }];
    expect(producedMetersForUnproducedRefund(db, jobs, { isStoneMeterQuote: true })).toBe(28);
    expect(producedMetersForUnproducedRefund(db, jobs, { isStoneMeterQuote: false })).toBe(28);
  });

  it('producedMetersForUnproducedRefund on hybrid stone uses roof metres, not flatsheet actual_meters', () => {
    const db = memDbWithCoils([]);
    const jobs = [
      {
        job_id: 'PRO-HY',
        status: 'Completed',
        actual_meters: 25,
        actual_roof_m: 60,
        actual_flatsheet_m: 25,
      },
    ];
    expect(producedMetersForUnproducedRefund(db, jobs, { isStoneMeterQuote: true })).toBe(60);
  });

  it('producedMetersForUnproducedRefund on hybrid stone-only (actual_meters=0) still counts roof', () => {
    const db = memDbWithCoils([]);
    const jobs = [
      {
        job_id: 'PRO-HY0',
        status: 'Completed',
        actual_meters: 0,
        actual_roof_m: 100,
        actual_flatsheet_m: 0,
      },
    ];
    expect(producedMetersForUnproducedRefund(db, jobs, { isStoneMeterQuote: true })).toBe(100);
  });

  it('producedMetersForUnproducedRefund counts offcut-only completed output', () => {
    const db = memDbWithCoils([]);
    const jobs = [{ job_id: 'PRO-OFF', status: 'Completed', actual_meters: 1, offcut_inventory_meters: 1 }];
    expect(producedMetersForUnproducedRefund(db, jobs, { isStoneMeterQuote: false })).toBe(1);
  });

  it('producedMetersForUnproducedRefund counts offcut_inventory when actual_meters was not posted', () => {
    const db = memDbWithCoils([]);
    const jobs = [{ job_id: 'PRO-OFF', status: 'Completed', actual_meters: 0, offcut_inventory_meters: 50 }];
    expect(producedMetersForUnproducedRefund(db, jobs, { isStoneMeterQuote: false })).toBe(50);
  });

  it('producedMetersForUnproducedRefund uses max of coil and actual per job', () => {
    const db = memDbWithCoils([{ job_id: 'PRO-MIX', meters_produced: 5 }]);
    const jobs = [{ job_id: 'PRO-MIX', status: 'Completed', actual_meters: 7 }];
    expect(producedMetersForUnproducedRefund(db, jobs)).toBe(7);
  });

  it('jobOutputMetresForUnproducedRefund includes post-completion FG adjustments', () => {
    const db = memDbWithCoils([{ job_id: 'PRO-ADJ', meters_produced: 10 }], { 'PRO-ADJ': -1.25 });
    const job = { job_id: 'PRO-ADJ', status: 'Completed', actual_meters: 10 };
    expect(jobOutputMetresForUnproducedRefund(db, job)).toBeCloseTo(8.75, 5);
    expect(producedMetersForUnproducedRefund(db, [job])).toBeCloseTo(8.75, 5);
  });

  it('uses the corrected roof metres, not the earlier lower actual_meters, and ignores a cancelled job', () => {
    const db = memDbWithCoils([]);
    const cancelled = { job_id: 'PRO-OLD', status: 'Cancelled', actual_meters: 8 };
    const completed = {
      job_id: 'PRO-NEW',
      status: 'Completed',
      actual_meters: 12,
      actual_roof_m: 40,
      actual_flatsheet_m: 12,
    };
    expect(jobEffectiveOutputMetresForRefund(db, cancelled)).toBe(0);
    expect(jobEffectiveOutputMetresForRefund(db, completed)).toBe(52);
    expect(producedMetersForUnproducedRefund(db, [cancelled, completed])).toBe(52);
    expect(producedMetersForUnproducedRefund(db, [cancelled, completed], { isStoneMeterQuote: true })).toBe(40);
  });

  it('producedMetersForUnproducedRefund applies FG adjustments on stone meter quotes', () => {
    const db = memDbWithCoils([], { 'PRO-ST-ADJ': -2 });
    const jobs = [{ job_id: 'PRO-ST-ADJ', status: 'Completed', actual_meters: 28 }];
    expect(producedMetersForUnproducedRefund(db, jobs, { isStoneMeterQuote: true })).toBe(26);
  });
});
