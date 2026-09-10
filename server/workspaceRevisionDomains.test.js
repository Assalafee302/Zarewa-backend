import { describe, it, expect } from 'vitest';
import { buildWorkspaceRevision } from './workspaceRevision.js';

/**
 * Stub db whose COUNT/MAX answer comes from a per-table fixture, so a test can move one
 * table and watch which domain revisions follow.
 * @param {Record<string, { c: number, m: string }>} tables
 */
function stubDb(tables) {
  return {
    prepare(sql) {
      const table = /FROM\s+(\w+)/.exec(sql)?.[1] ?? '';
      return { get: () => tables[table] ?? { c: 0, m: '' } };
    },
  };
}

const BASE = {
  quotations: { c: 10, m: '2026-09-01' },
  sales_receipts: { c: 5, m: '2026-09-01' },
  customers: { c: 100, m: '2026-09-01' },
  cutting_lists: { c: 3, m: '2026-09-01' },
  production_jobs: { c: 7, m: '2026-09-01' },
  purchase_orders: { c: 4, m: '2026-09-01' },
  coil_lots: { c: 20, m: '2026-09-01' },
  ledger_entries: { c: 50, m: '2026-09-01' },
  treasury_movements: { c: 8, m: '2026-09-01' },
  expenses: { c: 12, m: '2026-09-01' },
  payment_requests: { c: 2, m: '2026-09-01' },
  work_items: { c: 6, m: '2026-09-01' },
};

/** @param {Partial<typeof BASE>} overrides */
function revisionWith(overrides = {}) {
  return buildWorkspaceRevision(stubDb({ ...BASE, ...overrides }), 'KD');
}

describe('workspace revision domains', () => {
  it('exposes a revision per desk domain', () => {
    const r = revisionWith();
    expect(Object.keys(r.domains).sort()).toEqual(['finance', 'operations', 'procurement', 'sales']);
    for (const v of Object.values(r.domains)) expect(v).toMatch(/^[A-Za-z0-9_-]{16}$/);
  });

  it('is stable when nothing moves', () => {
    expect(revisionWith().domains).toEqual(revisionWith().domains);
  });

  it('leaves other desks alone when a quotation is added', () => {
    // The whole point: a sales edit must not make procurement re-pull its pack.
    const before = revisionWith().domains;
    const after = revisionWith({ quotations: { c: 11, m: '2026-09-10' } }).domains;
    expect(after.sales).not.toBe(before.sales);
    expect(after.procurement).toBe(before.procurement);
    expect(after.operations).toBe(before.operations);
    expect(after.finance).toBe(before.finance);
  });

  it('moves both desks a shared table feeds', () => {
    const before = revisionWith().domains;
    const after = revisionWith({ sales_receipts: { c: 6, m: '2026-09-10' } }).domains;
    expect(after.sales).not.toBe(before.sales);
    expect(after.finance).not.toBe(before.finance);
    expect(after.procurement).toBe(before.procurement);
    expect(after.operations).toBe(before.operations);
  });

  it('moves every desk for the cross-cutting work queue', () => {
    const before = revisionWith().domains;
    const after = revisionWith({ work_items: { c: 7, m: '2026-09-10' } }).domains;
    for (const d of ['sales', 'operations', 'finance', 'procurement']) {
      expect(after[d]).not.toBe(before[d]);
    }
  });

  it('still moves the global revision for any change', () => {
    // Clients that ignore `domains` must keep working exactly as before.
    expect(revisionWith({ expenses: { c: 13, m: '2026-09-10' } }).revision).not.toBe(
      revisionWith().revision
    );
  });

  it('separates branches so Yola activity cannot invalidate a Kaduna desk', () => {
    const kd = buildWorkspaceRevision(stubDb(BASE), 'KD').domains;
    const yl = buildWorkspaceRevision(stubDb(BASE), 'YL').domains;
    expect(kd.sales).not.toBe(yl.sales);
  });
});
