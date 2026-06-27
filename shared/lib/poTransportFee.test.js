import { describe, it, expect } from 'vitest';
import { poTransportQuotedFeeNgn } from './poTransportFee.js';

describe('poTransportQuotedFeeNgn', () => {
  it('uses transport_amount_ngn when set', () => {
    expect(poTransportQuotedFeeNgn({ transport_amount_ngn: 100_000, transport_advance_ngn: 40_000 })).toBe(
      100_000
    );
  });

  it('falls back to advance when total fee is zero', () => {
    expect(poTransportQuotedFeeNgn({ transport_amount_ngn: 0, transport_advance_ngn: 55_000 })).toBe(55_000);
    expect(poTransportQuotedFeeNgn({ transportAdvanceNgn: 30_000 })).toBe(30_000);
  });

  it('returns zero when neither is set', () => {
    expect(poTransportQuotedFeeNgn({})).toBe(0);
  });
});
