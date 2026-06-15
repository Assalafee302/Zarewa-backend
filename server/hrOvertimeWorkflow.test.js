/**
 * Overtime workflow state machine — no MySQL required (pure transition logic).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  approveHrOvertimeRequest,
  branchReviewHrOvertimeRequest,
  submitHrOvertimeRequest,
} from './hrPhase2Ops.js';

function mockDb(row) {
  const get = vi.fn(() => row);
  const run = vi.fn();
  const prepare = vi.fn(() => ({ get, run, all: vi.fn(() => []) }));
  return { prepare, _get: get, _run: run };
}

describe('HR overtime workflow guards', () => {
  it('submit requires draft status and owner', () => {
    const db = mockDb({ id: 'HROT-1', user_id: 'U1', status: 'submitted' });
    const r = submitHrOvertimeRequest(db, { id: 'U1' }, 'HROT-1');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('INVALID_STATUS');
  });

  it('approve rejects from submitted (must be hr_review)', () => {
    const db = mockDb({ id: 'HROT-1', user_id: 'U2', status: 'submitted' });
    const r = approveHrOvertimeRequest(db, { id: 'U1' }, 'HROT-1', {});
    expect(r.ok).toBe(false);
    expect(r.code).toBe('INVALID_STATUS');
  });

  it('branch review blocks self-approval', () => {
    const db = mockDb({ id: 'HROT-1', user_id: 'U1', status: 'submitted' });
    const r = branchReviewHrOvertimeRequest(db, { id: 'U1' }, 'HROT-1', { approve: true });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('FORBIDDEN');
  });
});
