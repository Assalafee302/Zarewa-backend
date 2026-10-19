import { describe, expect, it } from 'vitest';
import { overQuoteExcessNote, overQuoteRefusal, overQuoteSplit } from './overQuotePayout.js';

describe('over-quote payout (A5)', () => {
  it('splits a payment into the part within the quote and the excess', () => {
    expect(overQuoteSplit({ capNgn: 300000, alreadyPaidNgn: 200000, payNgn: 150000 })).toMatchObject({
      withinNgn: 100000,
      excessNgn: 50000,
    });
    expect(overQuoteSplit({ capNgn: 300000, alreadyPaidNgn: 0, payNgn: 300000 }).excessNgn).toBe(0);
    expect(overQuoteSplit({ capNgn: 300000, alreadyPaidNgn: 320000, payNgn: 10000 })).toMatchObject({
      withinNgn: 0,
      excessNgn: 10000,
    });
  });

  it('applies no cap when there is no quoted amount', () => {
    expect(overQuoteSplit({ capNgn: 0, alreadyPaidNgn: 0, payNgn: 5000 })).toMatchObject({ withinNgn: 5000, excessNgn: 0 });
  });

  it('refusal states the quote, the new total and the excess', () => {
    const r = overQuoteRefusal(overQuoteSplit({ capNgn: 300000, alreadyPaidNgn: 200000, payNgn: 150000 }), {
      what: 'Haulage',
      ref: 'PO-1',
      capLabel: 'quoted fee',
    });
    expect(r.code).toBe('PAYOUT_ABOVE_QUOTE');
    expect(r.error).toMatch(/₦350,000/);
    expect(r.error).toMatch(/₦300,000/);
    expect(r.error).toMatch(/by ₦50,000/);
  });

  it('excess line note carries approver and reason', () => {
    expect(overQuoteExcessNote({ reason: 'Extra trip to Zaria depot', approverName: 'Musa BM', capLabel: 'quoted fee' })).toBe(
      'Above quoted fee — approved by Musa BM: Extra trip to Zaria depot'
    );
  });
});
