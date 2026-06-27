import { describe, it, expect } from 'vitest';
import {
  coilProducedMetersFromProductionJobs,
  jobActualMetersFromProductionJobs,
  producedMetersForUnproducedRefund,
} from './refundCoilProducedMeters.js';

function memDbWithCoils(coilRows = []) {
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

  it('producedMetersForUnproducedRefund counts offcut-only completed output', () => {
    const db = memDbWithCoils([]);
    const jobs = [{ job_id: 'PRO-OFF', status: 'Completed', actual_meters: 1, offcut_inventory_meters: 1 }];
    expect(producedMetersForUnproducedRefund(db, jobs, { isStoneMeterQuote: false })).toBe(1);
  });

  it('producedMetersForUnproducedRefund uses max of coil and actual per job', () => {
    const db = memDbWithCoils([{ job_id: 'PRO-MIX', meters_produced: 5 }]);
    const jobs = [{ job_id: 'PRO-MIX', status: 'Completed', actual_meters: 7 }];
    expect(producedMetersForUnproducedRefund(db, jobs)).toBe(7);
  });
});
