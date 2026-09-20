import { describe, expect, it } from 'vitest';
import { QUOTE_FLOOR_FREEZE, resolveQuoteFloorFreeze } from './quoteFloorResolve.js';

function stubDb({ payDate = null } = {}) {
  return {
    prepare(sql) {
      const isReceipt = String(sql).includes('FROM sales_receipts');
      return {
        get: () => (isReceipt && payDate ? { d: payDate } : { d: null }),
        all: () => [],
        run: () => ({ changes: 0 }),
      };
    },
  };
}

describe('resolveQuoteFloorFreeze', () => {
  it('freezes unpaid dated quotes on quotation date', () => {
    const freeze = resolveQuoteFloorFreeze(stubDb(), {
      id: 'QT-UNPAID',
      date_iso: '2026-03-15',
      paid_ngn: 0,
    });
    expect(freeze.freezeEvent).toBe(QUOTE_FLOOR_FREEZE.QUOTATION_DATE);
    expect(freeze.freezeDateIso).toBe('2026-03-15');
    expect(freeze.asAtIso).toBe('2026-03-15');
    expect(freeze.why).toMatch(/quotation date \(2026-03-15\)/);
  });

  it('freezes paid quotes at first payment when a receipt exists', () => {
    const freeze = resolveQuoteFloorFreeze(stubDb({ payDate: '2026-04-01' }), {
      id: 'QT-PAID',
      date_iso: '2026-03-15',
      paid_ngn: 10000,
    });
    expect(freeze.freezeEvent).toBe(QUOTE_FLOOR_FREEZE.FIRST_PAYMENT);
    expect(freeze.freezeDateIso).toBe('2026-04-01');
    expect(freeze.why).toMatch(/first payment \(2026-04-01\)/);
  });

  it('uses live workbook for current pricingMode', () => {
    const freeze = resolveQuoteFloorFreeze(
      stubDb(),
      { id: 'QT-LIVE', date_iso: '2026-03-15', paid_ngn: 0 },
      { pricingMode: 'current' }
    );
    expect(freeze.freezeEvent).toBe(QUOTE_FLOOR_FREEZE.LIVE);
    expect(freeze.asAtIso).toBeUndefined();
  });
});
