import { describe, expect, it } from 'vitest';
import { assertBmOmOverride } from './managerOverride.js';
import { receiptCandidateAtISO } from './receiptDuplicateOps.js';

describe('receiptCandidateAtISO', () => {
  it('dates the new receipt on its bank day at the current time', () => {
    const now = new Date('2026-10-17T14:05:00.000Z');
    expect(receiptCandidateAtISO('2026-10-16', now)).toBe('2026-10-16T14:05:00.000Z');
    expect(receiptCandidateAtISO('', now)).toBe('2026-10-17T14:05:00.000Z');
  });
});

describe('BM/OM override', () => {
  const reason = 'Customer paid twice by mistake, second transfer confirmed on statement';
  it('accepts a branch manager or OM with a real reason', () => {
    expect(assertBmOmOverride({ actor: { roleKey: 'branch_manager', displayName: 'BM' }, reason, subject: 'x' }).ok).toBe(true);
    expect(assertBmOmOverride({ actor: { roleKey: 'operations_manager' }, reason, subject: 'x' }).ok).toBe(true);
  });
  it('refuses a cashier, and a short or keyboard reason', () => {
    expect(assertBmOmOverride({ actor: { roleKey: 'cashier' }, reason, subject: 'x' }).code).toBe('MANAGER_OVERRIDE_REQUIRED');
    expect(assertBmOmOverride({ actor: { roleKey: 'branch_manager' }, reason: 'ok', subject: 'x' }).code).toBe(
      'OVERRIDE_REASON_REQUIRED'
    );
    expect(assertBmOmOverride({ actor: { roleKey: 'branch_manager' }, reason: 'qwertyuiop', subject: 'x' }).code).toBe(
      'OVERRIDE_REASON_REQUIRED'
    );
  });
});
