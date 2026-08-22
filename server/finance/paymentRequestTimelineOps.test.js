import { describe, expect, it } from 'vitest';
import { describeTreasuryPayHow, sortTimelineEvents } from './paymentRequestTimelineOps.js';

describe('describeTreasuryPayHow', () => {
  it('names the till and GL when both are known', () => {
    expect(
      describeTreasuryPayHow({
        accountNames: ['HQ till'],
        amountNgn: 50_000,
        glCode: '1200',
        glLabel: 'Receivable (company loan)',
      })
    ).toBe('Cashier paid ₦50,000 from HQ till. Posted to 1200 Receivable (company loan).');
  });

  it('falls back to treasury when no account names', () => {
    expect(describeTreasuryPayHow({ amountNgn: 0 })).toBe('Cashier paid from treasury.');
  });
});

describe('sortTimelineEvents', () => {
  it('orders oldest first, then by id', () => {
    const sorted = sortTimelineEvents([
      { id: 'b', atIso: '2026-08-22T10:00:00.000Z' },
      { id: 'a', atIso: '2026-08-22T09:00:00.000Z' },
      { id: 'c', atIso: '2026-08-22T09:00:00.000Z' },
    ]);
    expect(sorted.map((e) => e.id)).toEqual(['a', 'c', 'b']);
  });
});
