import { describe, it, expect } from 'vitest';
import { refundPayoutHoldError, refundRowOnPayoutHold } from './refundPayoutHoldOps.js';

describe('refund payout hold', () => {
  it('rejects pay with the hold reason', () => {
    expect(refundPayoutHoldError('Confirm amount with customer')).toBe(
      'Refund on hold: Confirm amount with customer'
    );
    expect(refundPayoutHoldError('')).toBe('Refund on hold');
  });

  it('treats 1 as held and 0 as open', () => {
    expect(refundRowOnPayoutHold({ payout_hold: 1 })).toBe(true);
    expect(refundRowOnPayoutHold({ payoutHold: true })).toBe(true);
    expect(refundRowOnPayoutHold({ payout_hold: 0 })).toBe(false);
    expect(refundRowOnPayoutHold({})).toBe(false);
  });
});
