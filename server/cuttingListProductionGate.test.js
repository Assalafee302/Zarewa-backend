import { describe, expect, it } from 'vitest';
import { isCuttingListCancelledNotProduced, isCuttingListProductionCompleted } from './cuttingListProductionGate.js';

function mockDb(job) {
  return {
    prepare() {
      return {
        get() {
          return job;
        },
      };
    },
  };
}

describe('cuttingListProductionGate', () => {
  it('treats a cancelled-not-produced list as locked only while still on the register', () => {
    const cancelledJob = { job_id: 'J1', status: 'Cancelled' };
    expect(
      isCuttingListCancelledNotProduced(mockDb(cancelledJob), {
        id: 'CL-1',
        status: 'Cancelled',
        production_registered: 1,
        production_register_ref: 'J1',
      })
    ).toBe(true);
    expect(
      isCuttingListCancelledNotProduced(mockDb(cancelledJob), {
        id: 'CL-OLD',
        status: 'Waiting',
        production_registered: 0,
        production_register_ref: '',
      })
    ).toBe(false);
  });

  it('does not treat return-to-waiting as completed production', () => {
    expect(
      isCuttingListProductionCompleted(
        mockDb({ job_id: 'J2', status: 'Returned' }),
        {
          id: 'CL-2',
          status: 'Waiting',
          production_registered: 0,
          production_register_ref: '',
        }
      )
    ).toBe(false);
  });
});
