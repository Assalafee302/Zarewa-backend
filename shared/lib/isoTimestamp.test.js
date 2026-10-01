import { describe, expect, it } from 'vitest';
import {
  assertTreasuryPostingDate,
  normalizeIsoTimestampStrict,
  parseIsoTimestamp,
  periodKeyFromParsedDate,
} from './isoTimestamp.js';

describe('parseIsoTimestamp', () => {
  it('accepts a calendar day and a real ISO datetime', () => {
    expect(parseIsoTimestamp('2026-09-07')).toEqual({
      ok: true,
      day: '2026-09-07',
      iso: '2026-09-07T12:00:00.000Z',
    });
    const full = parseIsoTimestamp('2026-09-07T12:00:00.000Z');
    expect(full.ok).toBe(true);
    expect(full.day).toBe('2026-09-07');
    expect(full.iso).toBe('2026-09-07T12:00:00.000Z');
  });

  it('rejects TM-2780 garbage', () => {
    const bad = parseIsoTimestamp('262026-09-T12:00:00.000Z');
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe('INVALID_DATE');
  });
});

describe('periodKeyFromParsedDate', () => {
  it('throws on TM-2780 instead of returning 262026-09', () => {
    expect(() => periodKeyFromParsedDate('262026-09-T12:00:00.000Z')).toThrow(/Invalid date/);
  });

  it('accepts a YYYY-MM period key and a posting day', () => {
    expect(periodKeyFromParsedDate('2026-09')).toBe('2026-09');
    expect(periodKeyFromParsedDate('2026-09-07T12:00:00.000Z')).toBe('2026-09');
  });
});

describe('normalizeIsoTimestampStrict', () => {
  it('uses now only when the date is omitted', () => {
    const iso = normalizeIsoTimestampStrict('');
    expect(parseIsoTimestamp(iso).ok).toBe(true);
    expect(() => normalizeIsoTimestampStrict('262026-09-T12:00:00.000Z')).toThrow(/Invalid date/);
  });
});

describe('assertTreasuryPostingDate', () => {
  const today = '2026-10-01';

  it('rejects future dates unless Admin/MD gives a reason', () => {
    expect(() => assertTreasuryPostingDate({ day: '2026-10-02', todayDay: today, type: 'RECEIPT_IN' })).toThrow(
      /future/
    );
    expect(() =>
      assertTreasuryPostingDate({ day: '2026-10-02', todayDay: today, type: 'RECEIPT_IN', reason: 'x' })
    ).toThrow(/future/);
    expect(
      assertTreasuryPostingDate({
        day: '2026-10-02',
        todayDay: today,
        type: 'RECEIPT_IN',
        isPrivileged: true,
        reason: 'statement date',
      }).override
    ).toBe('future');
  });

  it('transfers: same day is free, 1-7 days back needs a reason, older needs Admin/MD', () => {
    expect(assertTreasuryPostingDate({ day: today, todayDay: today, type: 'INTERNAL_TRANSFER_OUT' }).override).toBe(
      null
    );
    try {
      assertTreasuryPostingDate({ day: '2026-09-28', todayDay: today, type: 'INTERNAL_TRANSFER_OUT' });
      throw new Error('expected throw');
    } catch (e) {
      expect(e.code).toBe('DATE_REASON_REQUIRED');
    }
    expect(
      assertTreasuryPostingDate({
        day: '2026-09-24',
        todayDay: today,
        type: 'INTERNAL_TRANSFER_OUT',
        reason: 'late bank advice',
      }).override
    ).toBe('backdate');
    try {
      assertTreasuryPostingDate({
        day: '2026-09-23',
        todayDay: today,
        type: 'INTERNAL_TRANSFER_IN',
        reason: 'cashier reason',
      });
      throw new Error('expected throw');
    } catch (e) {
      expect(e.code).toBe('DATE_ADMIN_REQUIRED');
    }
    expect(
      assertTreasuryPostingDate({
        day: '2026-09-23',
        todayDay: today,
        type: 'INTERNAL_TRANSFER_IN',
        isPrivileged: true,
        reason: 'statement backfill',
      }).gapDays
    ).toBe(8);
  });

  it('documents: more than 7 days from the source document date needs a reason', () => {
    expect(
      assertTreasuryPostingDate({
        day: '2026-08-05',
        todayDay: today,
        type: 'RECEIPT_IN',
        sourceDocDay: '2026-08-01',
      }).override
    ).toBe(null);
    try {
      assertTreasuryPostingDate({
        day: '2026-04-05',
        todayDay: today,
        type: 'RECEIPT_IN',
        sourceDocDay: '2026-08-07',
      });
      throw new Error('expected throw');
    } catch (e) {
      expect(e.code).toBe('DATE_REASON_REQUIRED');
      expect(e.message).toMatch(/document date 2026-08-07/);
    }
    expect(
      assertTreasuryPostingDate({
        day: '2026-09-10',
        todayDay: today,
        type: 'REFUND_PAYOUT',
        reason: 'statement date',
      }).override
    ).toBe('doc_gap');
  });
});
