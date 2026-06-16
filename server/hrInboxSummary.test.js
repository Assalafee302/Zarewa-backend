/**
 * HR inbox summary counts (unit mocks — no MySQL).
 */
import { describe, expect, it } from 'vitest';
import { getHrInboxSummary } from './hrOps.js';

function makeInboxDb({ draftPayroll = 0, draftAwaitingGm = 0, pendingHr = 0 } = {}) {
  return {
    prepare(sql) {
      const s = String(sql);
      if (s.includes('sqlite_master')) {
        return {
          get: () => ({ name: 'hr_requests' }),
        };
      }
      if (s.includes("status = 'draft'") && s.includes('gm_approved_at_iso')) {
        return { get: () => ({ c: draftAwaitingGm }) };
      }
      if (s.includes("FROM hr_payroll_runs") && s.includes("status = 'draft'")) {
        return { get: () => ({ c: draftPayroll }) };
      }
      if (s.includes("status = 'hr_review'") && s.includes('hr_requests')) {
        return { get: () => ({ c: pendingHr }) };
      }
      return {
        get: () => ({ c: 0 }),
        all: () => [],
        run: () => {},
      };
    },
  };
}

describe('getHrInboxSummary', () => {
  it('includes draftPayrollAwaitingGm separate from all draft runs', () => {
    const db = makeInboxDb({ draftPayroll: 4, draftAwaitingGm: 2, pendingHr: 1 });
    const r = getHrInboxSummary(db, { viewAll: true, branchId: 'HQ' });
    expect(r.ok).toBe(true);
    expect(r.counts.draftPayrollRuns).toBe(4);
    expect(r.counts.draftPayrollAwaitingGm).toBe(2);
    expect(r.counts.pendingHrReview).toBe(1);
  });
});
