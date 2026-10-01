import { describe, expect, it } from 'vitest';
import { assertTreasuryAmount } from './treasuryAmountPolicy.js';

describe('assertTreasuryAmount', () => {
  it('rejects zero', () => {
    expect(() => assertTreasuryAmount({ type: 'RECEIPT_IN', amountNgn: 0 })).toThrow(/non-zero/);
  });

  it('rejects the wrong sign', () => {
    expect(() => assertTreasuryAmount({ type: 'RECEIPT_IN', amountNgn: -100 })).toThrow(/positive/);
    expect(() => assertTreasuryAmount({ type: 'REFUND_PAYOUT', amountNgn: 100 })).toThrow(/negative/);
  });

  it('allows signed outflows and inflows', () => {
    expect(assertTreasuryAmount({ type: 'REFUND_PAYOUT', amountNgn: -5000 }).amountNgn).toBe(-5000);
    expect(assertTreasuryAmount({ type: 'RECEIPT_IN', amountNgn: 5000 }).amountNgn).toBe(5000);
  });

  it('requires a reason below the floor', () => {
    expect(() => assertTreasuryAmount({ type: 'RECEIPT_IN', amountNgn: 1, floorNgn: 100 })).toThrow(
      /confirmation reason/
    );
    expect(
      assertTreasuryAmount({
        type: 'RECEIPT_IN',
        amountNgn: 1,
        floorNgn: 100,
        amountFloorReason: 'rounding residue',
      }).ok
    ).toBe(true);
  });

  it('does not apply the floor to bank-style expenses or reversals', () => {
    expect(assertTreasuryAmount({ type: 'EXPENSE', amountNgn: -1, floorNgn: 100 }).ok).toBe(true);
    expect(
      assertTreasuryAmount({ type: 'RECEIPT_IN', amountNgn: 1, floorNgn: 100, isReversal: true }).ok
    ).toBe(true);
  });

  it('lets a reversal carry the negated sign but still rejects zero', () => {
    expect(assertTreasuryAmount({ type: 'RECEIPT_IN', amountNgn: -5000, isReversal: true }).ok).toBe(true);
    expect(() => assertTreasuryAmount({ type: 'RECEIPT_IN', amountNgn: 0, isReversal: true })).toThrow(/non-zero/);
  });
});
