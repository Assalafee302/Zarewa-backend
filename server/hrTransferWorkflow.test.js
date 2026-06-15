/**
 * Transfer approve must not skip review stages.
 */
import { describe, expect, it } from 'vitest';
import { patchHrTransferRequest } from './hrTransferRequests.js';

function makeDb(row) {
  const state = { ...row };
  return {
    prepare(sql) {
      const s = String(sql);
      if (s.includes('sqlite_master')) {
        return { get: () => ({ 1: 1 }) };
      }
      return {
        get(id) {
          if (s.includes('hr_transfer_requests') && s.includes('WHERE id')) {
            return state.id === id ? state : undefined;
          }
          return undefined;
        },
        run(...args) {
          if (s.includes('UPDATE hr_transfer_requests SET status')) {
            state.status = args[0];
          }
        },
      };
    },
  };
}

describe('HR transfer approve transitions', () => {
  it('cannot approve directly from submitted', () => {
    const db = makeDb({
      id: 'TR-1',
      status: 'submitted',
      transfer_type: 'branch',
      user_id: 'U1',
      from_branch_id: 'BR-A',
      to_branch_id: 'BR-B',
      timeline_json: '[]',
    });
    const r = patchHrTransferRequest(db, 'TR-1', { action: 'approve' }, { id: 'HR1' });
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/Cannot approve/);
  });
});
