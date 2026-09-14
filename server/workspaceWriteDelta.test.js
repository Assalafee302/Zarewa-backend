import { describe, expect, it } from 'vitest';
import { withWriteDelta } from './workspaceWriteDelta.js';

describe('withWriteDelta', () => {
  it('adds only non-empty bags', () => {
    const out = withWriteDelta(
      { ok: true, quotationId: 'Q1' },
      { quotations: [{ id: 'Q1' }], refunds: [], receipts: null }
    );
    expect(out.delta).toEqual({ quotations: [{ id: 'Q1' }] });
    expect(out.quotationId).toBe('Q1');
  });

  it('returns payload unchanged when bags are empty', () => {
    const base = { ok: true };
    expect(withWriteDelta(base, { receipts: [] })).toBe(base);
  });
});
