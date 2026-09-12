import { describe, expect, it } from 'vitest';
import { withWriteDelta } from './workspaceWriteDelta.js';
import { entityIdsFromWriteBody } from './workspaceDataEvents.js';

describe('workspace write delta helpers', () => {
  it('withWriteDelta adds only non-empty bags', () => {
    const out = withWriteDelta(
      { ok: true, quotationId: 'Q1' },
      { quotations: [{ id: 'Q1' }], refunds: [], receipts: null }
    );
    expect(out.delta).toEqual({ quotations: [{ id: 'Q1' }] });
    expect(out.quotationId).toBe('Q1');
  });

  it('entityIdsFromWriteBody extracts stable ids', () => {
    const ids = entityIdsFromWriteBody({
      ok: true,
      delta: {
        quotations: [{ id: 'QT-1' }],
        productionJobs: [{ jobID: 'JOB-1' }],
        refunds: [{ refundID: 'RF-1' }],
      },
    });
    expect(ids).toEqual({
      quotations: ['QT-1'],
      productionJobs: ['JOB-1'],
      refunds: ['RF-1'],
    });
  });
});
