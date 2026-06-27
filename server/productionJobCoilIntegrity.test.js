import { describe, it, expect } from 'vitest';
import { repairProductionJobCoilIntegrity } from './productionTraceability.js';

describe('repairProductionJobCoilIntegrity', () => {
  it('adds missing coil rows for a job that only partially appears in a trimmed slice', () => {
    const trimmed = [
      {
        id: 'PJC-1',
        jobID: 'PRO-MULTI',
        sequenceNo: 1,
        coilNo: 'CL-A',
        openingWeightKg: 1000,
        closingWeightKg: 0,
        consumedWeightKg: 0,
        metersProduced: 0,
        allocationStatus: 'Allocated',
      },
    ];
    const db = {
      prepare(sql) {
        const s = String(sql);
        return {
          all(...jobIds) {
            if (!s.includes('production_job_coils') || !s.includes('job_id IN')) return [];
            if (!jobIds.includes('PRO-MULTI')) return [];
            return [
              {
                id: 'PJC-1',
                job_id: 'PRO-MULTI',
                sequence_no: 1,
                coil_no: 'CL-A',
                opening_weight_kg: 1000,
                closing_weight_kg: 0,
                consumed_weight_kg: 0,
                meters_produced: 0,
                allocation_status: 'Allocated',
              },
              {
                id: 'PJC-2',
                job_id: 'PRO-MULTI',
                sequence_no: 2,
                coil_no: 'CL-B',
                opening_weight_kg: 800,
                closing_weight_kg: 0,
                consumed_weight_kg: 0,
                meters_produced: 0,
                allocation_status: 'Allocated',
              },
            ];
          },
        };
      },
    };
    const repaired = repairProductionJobCoilIntegrity(
      db,
      [{ jobID: 'PRO-MULTI', status: 'Planned' }],
      trimmed
    );
    const forJob = repaired.filter((c) => c.jobID === 'PRO-MULTI').sort((a, b) => a.sequenceNo - b.sequenceNo);
    expect(forJob).toHaveLength(2);
    expect(forJob.map((c) => c.coilNo)).toEqual(['CL-A', 'CL-B']);
  });
});
