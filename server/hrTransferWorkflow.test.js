/**
 * Transfer workflow stage transitions.
 */
import { describe, expect, it } from 'vitest';
import { patchHrTransferRequest } from './hrTransferRequests.js';

function makeDb(row) {
  const state = { ...row };
  return {
    prepare(sql) {
      const s = String(sql);
      if (s.includes('sqlite_master')) return { get: () => ({ 1: 1 }) };
      return {
        get(...args) {
          if (s.includes('hr_transfer_requests') && s.includes('WHERE id')) {
            return state.id === args[0]
              ? { ...state, transfer_type: state.transfer_type, user_id: state.user_id, from_branch_id: state.from_branch_id }
              : undefined;
          }
          if (s.includes('display_name')) return { display_name: 'Test' };
          if (s.includes('line_manager')) return { line_manager_user_id: null };
          return undefined;
        },
        all() {
          return [];
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

describe('hrTransferWorkflow', () => {
  it('branch endorsement advances inter_branch to hr_review', () => {
    const db = makeDb({
      id: 'xfer_1',
      user_id: 'U1',
      transfer_type: 'inter_branch',
      from_branch_id: 'BR-A',
      status: 'branch_review',
      timeline_json: '[]',
    });
    const r = patchHrTransferRequest(db, 'xfer_1', { action: 'hr_review' }, { id: 'BM1' });
    expect(r.ok).toBe(true);
    expect(db.prepare(`SELECT * FROM hr_transfer_requests WHERE id = ?`).get('xfer_1').status).toBe('hr_review');
  });

  it('rejects GM final approve from HR admin without gm_approve permission', () => {
    const db = makeDb({
      id: 'xfer_2',
      user_id: 'U1',
      transfer_type: 'inter_branch',
      from_branch_id: 'BR-A',
      status: 'gm_approval',
      timeline_json: '[]',
    });
    const r = patchHrTransferRequest(
      db,
      'xfer_2',
      { action: 'approve' },
      { id: 'HR1', permissions: ['hr.transfers.manage', 'hr.staff.manage'] }
    );
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/GM HR/i);
  });

  it('allows GM final approve when actor has gm_approve permission', () => {
    const db = makeDb({
      id: 'xfer_3',
      user_id: 'U1',
      transfer_type: 'inter_branch',
      from_branch_id: 'BR-A',
      status: 'gm_approval',
      timeline_json: '[]',
    });
    const r = patchHrTransferRequest(
      db,
      'xfer_3',
      { action: 'approve' },
      { id: 'GM1', permissions: ['hr.requests.gm_approve'] }
    );
    expect(r.ok).toBe(true);
    expect(db.prepare(`SELECT * FROM hr_transfer_requests WHERE id = ?`).get('xfer_3').status).toBe('approved');
  });
});
