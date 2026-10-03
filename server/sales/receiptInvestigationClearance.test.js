import { describe, expect, it } from 'vitest';
import {
  receiptInvestigationClearanceBlock,
  receiptStatusIsSuspended,
} from './receiptInvestigationClearance.js';

describe('receiptInvestigationClearanceBlock', () => {
  it('blocks a suspended receipt for every actor', () => {
    const block = receiptInvestigationClearanceBlock(null, {
      id: 'LE-KD-26-1767',
      status: 'Suspended - investigation',
    });
    expect(receiptStatusIsSuspended('Suspended - investigation')).toBe(true);
    expect(block?.code).toBe('UNDER_INVESTIGATION');
    expect(block?.ok).toBe(false);
  });

  it('blocks an open investigation link even when status is still pending', () => {
    const db = {
      prepare() {
        return {
          get() {
            return { ok: 1 };
          },
          all() {
            return [{ entity_id: 'LE-1', case_id: 'INV-KD-26-0001', status: 'open' }];
          },
        };
      },
    };
    const block = receiptInvestigationClearanceBlock(db, { id: 'LE-1', status: 'Pending' });
    expect(block?.error).toMatch(/INV-KD-26-0001/);
  });

  it('leaves an ordinary pending receipt alone', () => {
    const db = {
      prepare() {
        return {
          get() {
            return { ok: 1 };
          },
          all() {
            return [];
          },
        };
      },
    };
    expect(receiptInvestigationClearanceBlock(db, { id: 'LE-OTHER', status: 'Pending' })).toBeNull();
  });
});
