import { describe, it, expect, vi } from 'vitest';
import { recordCuttingListPrint } from './writeOps.js';

function mockDbForCuttingList(status = 'Planned') {
  const updates = [];
  return {
    prepare(sql) {
      const s = String(sql);
      return {
        get: vi.fn(() => {
          if (/FROM cutting_lists WHERE id/i.test(s)) {
            return { id: 'CL-26-001', status };
          }
          if (/print_count FROM cutting_lists/i.test(s)) {
            return { print_count: 1 };
          }
          return undefined;
        }),
        run: vi.fn((...args) => {
          if (/UPDATE cutting_lists/i.test(s)) updates.push(args);
          return { changes: 1 };
        }),
      };
    },
    updates,
  };
}

vi.mock('./controlOps.js', () => ({
  appendAuditLog: vi.fn(),
  assertPeriodOpen: vi.fn(),
  insertPaymentRequest: vi.fn(),
}));

describe('recordCuttingListPrint', () => {
  it('rejects draft cutting lists', () => {
    const db = mockDbForCuttingList('Draft');
    const result = recordCuttingListPrint(db, 'CL-26-001', { displayName: 'Sales' });
    expect(result).toEqual({
      ok: false,
      error: 'Draft cutting lists cannot be printed. Save the list first.',
    });
    expect(db.updates).toHaveLength(0);
  });

  it('records print for saved cutting lists', () => {
    const db = mockDbForCuttingList('Planned');
    const result = recordCuttingListPrint(db, 'CL-26-001', { displayName: 'Sales' });
    expect(result.ok).toBe(true);
    expect(result.printCount).toBe(1);
    expect(db.updates).toHaveLength(1);
  });
});
