import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  refundCreditAppliedNgn,
  refundCreditSettledNgn,
  refundCreditTargetsFor,
} from './refundCreditLedger.js';

/**
 * Stub db returning a fixed SUM for the applications query.
 * @param {number | null} sum null makes the query throw, standing in for a host whose
 *   migration has not created the table yet.
 */
function stubDb(sum, targetRows = []) {
  return {
    prepare() {
      return {
        get: () => {
          if (sum === null) throw new Error('no such table: refund_credit_applications');
          return { s: sum };
        },
        all: () => {
          if (sum === null) throw new Error('no such table: refund_credit_applications');
          return targetRows;
        },
      };
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('refundCreditAppliedNgn', () => {
  it('returns the summed live applications', () => {
    expect(refundCreditAppliedNgn(stubDb(800), 'RF-1')).toBe(800);
  });

  it('is zero with no refund id', () => {
    expect(refundCreditAppliedNgn(stubDb(800), '')).toBe(0);
  });

  it('never returns a negative', () => {
    expect(refundCreditAppliedNgn(stubDb(-50), 'RF-1')).toBe(0);
  });

  it('falls back to zero when the table is not there yet', () => {
    // Pending migration must not crash a payout screen; the caller still has the counter.
    expect(refundCreditAppliedNgn(stubDb(null), 'RF-1')).toBe(0);
  });
});

describe('refundCreditTargetsFor', () => {
  it('lists every quotation the credit went to, oldest first', () => {
    // The row's own column would name only QT-B; the split is the whole point.
    const db = stubDb(500, [
      { target_quotation_ref: 'QT-1170' },
      { target_quotation_ref: 'QT-1183' },
    ]);
    expect(refundCreditTargetsFor(db, 'RF-1')).toEqual(['QT-1170', 'QT-1183']);
  });

  it('de-duplicates repeat applies onto the same job', () => {
    const db = stubDb(500, [
      { target_quotation_ref: 'QT-1170' },
      { target_quotation_ref: 'QT-1170' },
      { target_quotation_ref: 'QT-1183' },
    ]);
    expect(refundCreditTargetsFor(db, 'RF-1')).toEqual(['QT-1170', 'QT-1183']);
  });

  it('drops blank refs and returns empty for no id or missing table', () => {
    expect(refundCreditTargetsFor(stubDb(0, [{ target_quotation_ref: '  ' }]), 'RF-1')).toEqual([]);
    expect(refundCreditTargetsFor(stubDb(0, []), '')).toEqual([]);
    expect(refundCreditTargetsFor(stubDb(null), 'RF-1')).toEqual([]);
  });
});

describe('refundCreditSettledNgn', () => {
  it('agrees with both records when they agree', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const row = { refund_id: 'RF-1', credit_applied_ngn: 500 };
    expect(refundCreditSettledNgn(stubDb(500), row)).toBe(500);
    expect(warn).not.toHaveBeenCalled();
  });

  it('trusts the ledger when the counter lost an apply', () => {
    // Two applies racing across workers: both application rows land, one counter
    // update is overwritten. Settling on the short counter would pay the customer
    // a second time for credit they already received.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const row = { refund_id: 'RF-1', credit_applied_ngn: 300 };
    expect(refundCreditSettledNgn(stubDb(800), row)).toBe(800);
  });

  it('trusts the counter when the stamp wrote no application row', () => {
    // The leftover-overpay path bumps the counter directly. The ledger alone would
    // understate that credit and the till would pay it out again.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const row = { refund_id: 'RF-1', credit_applied_ngn: 900 };
    expect(refundCreditSettledNgn(stubDb(200), row)).toBe(900);
  });

  it('logs whenever the two records disagree', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    refundCreditSettledNgn(stubDb(800), { refund_id: 'RF-9578', credit_applied_ngn: 300 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('RF-9578');
  });

  it('reads a camelCase row the same as a snake_case one', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(refundCreditSettledNgn(stubDb(0), { refundID: 'RF-1', creditAppliedNgn: 450 })).toBe(450);
  });

  it('falls back to the counter when the table is missing', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const row = { refund_id: 'RF-1', credit_applied_ngn: 700 };
    expect(refundCreditSettledNgn(stubDb(null), row)).toBe(700);
  });

  it('returns the counter untouched when the row has no id', () => {
    expect(refundCreditSettledNgn(stubDb(999), { credit_applied_ngn: 120 })).toBe(120);
  });

  it('treats a missing counter as zero rather than NaN', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(refundCreditSettledNgn(stubDb(0), { refund_id: 'RF-1' })).toBe(0);
    expect(refundCreditSettledNgn(stubDb(250), { refund_id: 'RF-1' })).toBe(250);
  });
});
