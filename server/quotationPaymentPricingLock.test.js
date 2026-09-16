import { describe, expect, it } from 'vitest';
import {
  quotationFirstPaymentDateIso,
  quotationPricingAsAtIso,
  quotationPricingLockAsAtIso,
} from './pricingAsOf.js';

function mockDb(receipts) {
  return {
    prepare(sql) {
      const s = String(sql);
      if (s.includes('FROM sales_receipts')) {
        return {
          get(qid) {
            const rows = receipts.filter((r) => r.quotation_ref === qid);
            const dates = rows
              .filter((r) => Number(r.amount_ngn) > 0)
              .filter((r) => !/void|cancel|revers/i.test(String(r.status || '')))
              .map((r) => String(r.date_iso || '').slice(0, 10))
              .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d))
              .sort();
            return { d: dates[0] || null };
          },
        };
      }
      return { get: () => null, all: () => [], run: () => ({ changes: 0 }) };
    },
  };
}

describe('quotation payment pricing lock', () => {
  it('unpaid quotes have no payment lock (MD gates use quote date separately)', () => {
    const db = mockDb([]);
    expect(quotationPricingLockAsAtIso(db, { id: 'QT-1', date_iso: '2026-01-10', paid_ngn: 0 })).toBeNull();
    expect(quotationFirstPaymentDateIso(db, 'QT-1')).toBeNull();
  });

  it('locks to first receipt date when paid', () => {
    const db = mockDb([
      { quotation_ref: 'QT-1', amount_ngn: 50_000, status: 'Cleared', date_iso: '2026-02-05' },
      { quotation_ref: 'QT-1', amount_ngn: 20_000, status: 'Cleared', date_iso: '2026-03-01' },
    ]);
    expect(quotationFirstPaymentDateIso(db, 'QT-1')).toBe('2026-02-05');
    expect(quotationPricingLockAsAtIso(db, { id: 'QT-1', date_iso: '2026-01-10', paid_ngn: 70000 })).toBe(
      '2026-02-05'
    );
    expect(quotationPricingAsAtIso({ id: 'QT-1', date_iso: '2026-01-10' }, db)).toBe('2026-02-05');
  });

  it('falls back to quotation date when paid_ngn but no receipt row', () => {
    const db = mockDb([]);
    expect(quotationPricingLockAsAtIso(db, { id: 'QT-2', date_iso: '2026-01-15', paid_ngn: 1000 })).toBe(
      '2026-01-15'
    );
  });

  it('without db still uses quotation date', () => {
    expect(quotationPricingAsAtIso({ date_iso: '2026-04-01' })).toBe('2026-04-01');
  });
});
