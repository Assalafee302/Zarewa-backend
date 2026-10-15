import { describe, expect, it } from 'vitest';
import { calendarMonthKey } from './bankStatementBalanceOps.js';

describe('statement balances — period key', () => {
  it('only a whole calendar month has a period key', () => {
    expect(calendarMonthKey('2026-08-01', '2026-08-31')).toBe('2026-08');
    expect(calendarMonthKey('2026-02-01', '2026-02-28')).toBe('2026-02');
    expect(calendarMonthKey('2026-08-01', '2026-08-30')).toBe('');
    expect(calendarMonthKey('2026-08-02', '2026-08-31')).toBe('');
  });
});
