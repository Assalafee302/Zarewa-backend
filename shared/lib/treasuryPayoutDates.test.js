import { describe, expect, it } from 'vitest';
import {
  latestPayoutDay,
  latestPayoutPostedAtISO,
  payoutLinePostedAtISO,
  payoutLinePostedDay,
} from './treasuryPayoutDates.js';

describe('treasuryPayoutDates', () => {
  it('uses line dateISO over fallback', () => {
    expect(payoutLinePostedDay({ dateISO: '2026-05-01' }, '2026-06-01')).toBe('2026-05-01');
  });

  it('falls back to paidAtISO on payload-shaped lines', () => {
    expect(payoutLinePostedDay({ paidAtISO: '2026-04-15' }, '')).toBe('2026-04-15');
  });

  it('formats day-only posted at noon UTC', () => {
    expect(payoutLinePostedAtISO({ dateISO: '2026-03-10' })).toBe('2026-03-10T12:00:00.000Z');
  });

  it('rejects a garbage line date instead of saving "262026-09-T12…" (TM-2780)', () => {
    expect(() => payoutLinePostedAtISO({ dateISO: '262026-09-07' }, '2026-09-07')).toThrow(/Payment line date/);
    expect(() => payoutLinePostedDay({ dateISO: '2026-02-30' })).toThrow(/Invalid calendar date/);
  });

  it('uses the fallback only when the line has no date', () => {
    expect(payoutLinePostedAtISO({}, '2026-09-07')).toBe('2026-09-07T12:00:00.000Z');
  });

  it('keeps a full transfer timestamp (voucher time, not noon)', () => {
    expect(payoutLinePostedAtISO({ dateISO: '2026-09-07T15:30:00.000Z' })).toBe(
      '2026-09-07T15:30:00.000Z'
    );
    expect(payoutLinePostedAtISO({ postedAtISO: '2026-10-07T17:39:00.000Z' })).toBe(
      '2026-10-07T17:39:00.000Z'
    );
  });

  it('picks latest day for mixed batch', () => {
    const lines = [{ dateISO: '2026-01-05' }, { dateISO: '2026-01-20' }];
    expect(latestPayoutDay(lines, (l) => payoutLinePostedDay(l))).toBe('2026-01-20');
  });

  it('picks latest full posted-at for voucher paidAtISO', () => {
    const lines = [
      { postedAtISO: '2026-10-07T12:00:00.000Z' },
      { postedAtISO: '2026-10-07T17:39:00.000Z' },
    ];
    expect(latestPayoutPostedAtISO(lines)).toBe('2026-10-07T17:39:00.000Z');
  });
});
