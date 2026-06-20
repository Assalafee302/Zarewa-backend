import { describe, expect, it } from 'vitest';
import { mapJobsForAp1cReclass } from './ap1cReclassOps.js';

describe('ap1cReclass (pure)', () => {
  it('mapJobsForAp1cReclass normalizes job id and production fields', () => {
    const rows = mapJobsForAp1cReclass([
      { jobID: 'J-1', status: 'completed', actualMeters: 120, quotationRef: 'Q-99' },
      { id: 'J-2', status: 'draft', actual_metres: 0, quotation_ref: 'Q-100' },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      jobID: 'J-1',
      status: 'completed',
      actualMeters: 120,
      quotationRef: 'Q-99',
    });
    expect(rows[1].jobID).toBe('J-2');
    expect(rows[1].actualMeters).toBe(0);
    expect(rows[1].quotationRef).toBe('Q-100');
  });
});
