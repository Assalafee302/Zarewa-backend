import { describe, it, expect } from 'vitest';
import { coilProducedMetersFromProductionJobs } from './refundCoilProducedMeters.js';

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
});
