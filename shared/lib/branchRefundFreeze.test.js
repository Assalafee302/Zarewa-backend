import { describe, expect, it } from 'vitest';
import {
  calendarDayFromIso,
  dateInBranchRefundLockWindow,
  formatBranchRefundsFrozenError,
  normalizeBranchRefundsBlockedFromIso,
  quotationHitsBranchRefundLockWindow,
} from './branchRefundFreeze.js';

describe('branchRefundFreeze', () => {
  it('normalizes date-only to start of UTC day', () => {
    expect(normalizeBranchRefundsBlockedFromIso('2026-06-01')).toBe('2026-06-01T00:00:00.000Z');
    expect(calendarDayFromIso('2026-09-16T23:59:59.999Z')).toBe('2026-09-16');
  });

  it('locks quotation/receipt calendar days inside an inclusive from–to window', () => {
    const freeze = {
      refunds_blocked_from_iso: '2026-09-01',
      refunds_blocked_to_iso: '2026-09-16',
    };
    expect(dateInBranchRefundLockWindow('2026-08-31', freeze)).toBe(false);
    expect(dateInBranchRefundLockWindow('2026-09-01', freeze)).toBe(true);
    expect(dateInBranchRefundLockWindow('2026-09-10', freeze)).toBe(true);
    expect(dateInBranchRefundLockWindow('2026-09-16', freeze)).toBe(true);
    expect(dateInBranchRefundLockWindow('2026-09-17', freeze)).toBe(false);
  });

  it('locks a quote outside the window when a receipt sits inside it', () => {
    const freeze = {
      refundsBlockedFromISO: '2026-09-01',
      refundsBlockedToISO: '2026-09-16',
    };
    expect(
      quotationHitsBranchRefundLockWindow(
        { quotationDateISO: '2026-08-20', receiptDateISOs: ['2026-09-05'] },
        freeze
      )
    ).toBe(true);
    expect(
      quotationHitsBranchRefundLockWindow(
        { quotationDateISO: '2026-08-20', receiptDateISOs: ['2026-08-21'] },
        freeze
      )
    ).toBe(false);
  });

  it('open-ended from-date locks on/after that day when to is blank', () => {
    const freeze = { refunds_blocked_from_iso: '2026-06-01T00:00:00.000Z' };
    expect(dateInBranchRefundLockWindow('2026-05-31', freeze)).toBe(false);
    expect(dateInBranchRefundLockWindow('2026-06-01', freeze)).toBe(true);
    expect(dateInBranchRefundLockWindow('2026-09-18', freeze)).toBe(true);
  });

  it('formats a range error as already settled', () => {
    const msg = formatBranchRefundsFrozenError(
      {
        name: 'Yola Factory',
        refunds_blocked_from_iso: '2026-09-01',
        refunds_blocked_to_iso: '2026-09-16',
        refunds_blocked_reason: 'Historical catch-up locked after expense import.',
      },
      'Yola Factory'
    );
    expect(msg).toMatch(/Yola Factory/);
    expect(msg).toMatch(/2026-09-01 to 2026-09-16/);
    expect(msg).toMatch(/already settled/);
    expect(msg).toMatch(/Historical catch-up/);
  });
});
