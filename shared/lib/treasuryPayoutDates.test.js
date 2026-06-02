import { describe, expect, it } from 'vitest';
import { latestPayoutDay, payoutLinePostedAtISO, payoutLinePostedDay } from './treasuryPayoutDates.js';

describe('treasuryPayoutDates', () => {
  it('uses line dateISO over fallback', () => {
    expect(payoutLinePostedDay({ dateISO: '2026-05-01' }, '2026-06-01')).toBe('2026-05-01');
  });

  it('falls back to paidAtISO on payload-shaped lines', () => {
    expect(payoutLinePostedDay({ paidAtISO: '2026-04-15' }, '')).toBe('2026-04-15');
  });

  it('formats posted at noon UTC', () => {
    expect(payoutLinePostedAtISO({ dateISO: '2026-03-10' })).toBe('2026-03-10T12:00:00.000Z');
  });

  it('picks latest day for mixed batch', () => {
    const lines = [{ dateISO: '2026-01-05' }, { dateISO: '2026-01-20' }];
    expect(latestPayoutDay(lines, (l) => payoutLinePostedDay(l))).toBe('2026-01-20');
  });
});
