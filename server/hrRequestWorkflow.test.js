/**
 * Leave/loan request workflow — approval chain order and stage transitions.
 */
import { describe, expect, it } from 'vitest';
import { branchManagerEndorseRequest, hrReviewRequest } from './hrOps.js';

function makeRequestDb(initialRow) {
  const state = { ...initialRow };
  return {
    prepare(sql) {
      const s = String(sql);
      if (s.includes('sqlite_master')) {
        return { get: () => ({ 1: 1 }) };
      }
      return {
        get(...args) {
          if (s.includes('FROM hr_requests WHERE id')) {
            return state.id === args[0] ? state : undefined;
          }
          if (s.includes('FROM app_users WHERE id')) {
            return { display_name: 'Test Staff' };
          }
          if (s.includes('line_manager_user_id')) {
            return { line_manager_user_id: null };
          }
          return undefined;
        },
        all() {
          if (s.includes('role_key IN')) return [];
          return [];
        },
        run(...args) {
          if (s.includes('UPDATE hr_requests SET status')) {
            if (s.includes("'branch_manager_review'")) state.status = 'branch_manager_review';
            if (s.includes("'gm_hr_review'")) state.status = 'gm_hr_review';
            if (s.includes("'rejected'")) state.status = 'rejected';
          }
        },
      };
    },
  };
}

describe('hrRequestWorkflow transitions', () => {
  it('hrReviewRequest approve forwards to branch_manager_review for leave', () => {
    const db = makeRequestDb({
      id: 'HRR-TEST',
      user_id: 'U1',
      branch_id: 'BR-KD',
      kind: 'leave',
      status: 'hr_review',
    });
    const actor = { id: 'HR1', displayName: 'HR Officer' };
    const r = hrReviewRequest(db, 'HRR-TEST', actor, true, 'Approved for annual leave', 'policy');
    expect(r.ok).toBe(true);
    expect(db.prepare(`SELECT * FROM hr_requests WHERE id = ?`).get('HRR-TEST').status).toBe('branch_manager_review');
  });

  it('branchManagerEndorseRequest approve forwards to gm_hr_review', () => {
    const db = makeRequestDb({
      id: 'HRR-TEST2',
      user_id: 'U1',
      branch_id: 'BR-KD',
      kind: 'loan',
      status: 'branch_manager_review',
    });
    const actor = { id: 'BM1', displayName: 'Branch Manager' };
    const r = branchManagerEndorseRequest(db, 'HRR-TEST2', actor, true, 'Endorsed for branch team', 'policy');
    expect(r.ok).toBe(true);
    expect(db.prepare(`SELECT * FROM hr_requests WHERE id = ?`).get('HRR-TEST2').status).toBe('gm_hr_review');
  });
});
