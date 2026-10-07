import { describe, expect, it } from 'vitest';
import { supplierPaymentCapBlock } from './poSupplierAdvanceGuard.js';
import { daysOutstanding, SUPPLIER_ADVANCE_STALE_DAYS } from './supplierAdvanceAge.js';

describe('supplier payment cap', () => {
  it('allows a payment while the order is not yet paid up', () => {
    expect(supplierPaymentCapBlock({ paidNgn: 1_000, orderedNgn: 5_000, mdNote: '' })).toBeNull();
  });

  it('blocks a further payment once paid has reached the order value', () => {
    const block = supplierPaymentCapBlock({ paidNgn: 5_000, orderedNgn: 5_000, mdNote: '' });
    expect(block?.code).toBe('PO_PAID_IN_FULL');
  });

  it('allows the further payment when the MD note is present', () => {
    expect(
      supplierPaymentCapBlock({ paidNgn: 5_920_240, orderedNgn: 5_786_080, mdNote: 'MD approved the second transfer' })
    ).toBeNull();
  });
});

describe('supplier advance age', () => {
  it('counts days from the first payment to the as-of date', () => {
    expect(daysOutstanding('2026-08-06', '2026-10-07')).toBe(62);
    expect(62 > SUPPLIER_ADVANCE_STALE_DAYS).toBe(true);
    expect(daysOutstanding('2026-09-11', '2026-10-07')).toBe(26);
  });
});
