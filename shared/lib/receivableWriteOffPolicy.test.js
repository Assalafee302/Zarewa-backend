import { describe, expect, it } from 'vitest';
import {
  evaluateReceivableWriteOff,
  isMinorReceivableForBranchManager,
  maxRoundOffWaiveNgn,
  registerReceivableOutstandingNgn,
  roundOffToleranceNgn,
} from './receivableWriteOffPolicy.js';

describe('receivableWriteOffPolicy', () => {
  it('roundOffToleranceNgn is capped by the ₦1 payment tolerance, itself capped at 5000', () => {
    // PAYMENT_OUTSTANDING_TOLERANCE_NGN is a deliberate absolute ₦1 tolerance (see
    // paymentOutstandingTolerance.test.js) — it, not MAX_ROUND_OFF_WAIVE_NGN, is the binding
    // constraint here for any realistic total, so this never reaches the 5000 cap in practice.
    expect(roundOffToleranceNgn(1_000_000)).toBe(1);
    expect(roundOffToleranceNgn(10_000)).toBeLessThanOrEqual(5000);
  });

  it('allows round-off only when effectively fully paid', () => {
    expect(maxRoundOffWaiveNgn(1_250_300, 1_250_000, 0)).toBe(300);
    expect(maxRoundOffWaiveNgn(1_000_000, 900_000, 0)).toBe(0);
  });

  it('allows branch manager to waive minor receivables under 1000 naira', () => {
    expect(isMinorReceivableForBranchManager(800, 1_449_200)).toBe(true);
    expect(maxRoundOffWaiveNgn(1_450_000, 1_449_200, 0)).toBe(800);
    const minor = evaluateReceivableWriteOff(1_450_000, 1_449_200, 0);
    expect(minor.kind).toBe('round_off');
    expect(minor.requiresMd).toBe(false);
    expect(isMinorReceivableForBranchManager(1_000, 500_000)).toBe(false);
    expect(isMinorReceivableForBranchManager(500, 0)).toBe(false);
  });

  it('registerReceivableOutstandingNgn shows the real residual once payment tolerance is ₦1', () => {
    // Under the strict absolute ₦1 payment tolerance, a ₦300 residual is no longer
    // "effectively fully paid" — the register now shows it as a real receivable rather than
    // hiding it, even though it still falls in the minor-receivable band a Branch Manager can
    // waive via maxRoundOffWaiveNgn (see 'allows round-off only when effectively fully paid').
    expect(registerReceivableOutstandingNgn(1_250_300, 1_250_000, 0)).toBe(300);
    expect(registerReceivableOutstandingNgn(1_000_000, 900_000, 0)).toBe(100_000);
  });

  it('classifies round_off vs bad_debt', () => {
    const small = evaluateReceivableWriteOff(1_250_300, 1_250_000, 0);
    expect(small.kind).toBe('round_off');
    expect(small.requiresMd).toBe(false);

    const large = evaluateReceivableWriteOff(1_000_000, 800_000, 0);
    expect(large.kind).toBe('bad_debt');
    expect(large.requiresMd).toBe(true);

    const settlement = evaluateReceivableWriteOff(1_000_000, 960_000, 0);
    expect(settlement.kind).toBe('settlement');
    expect(settlement.requiresMd).toBe(true);
  });

  it('blocks round-off when no payment', () => {
    const r = evaluateReceivableWriteOff(500_000, 0, 0);
    expect(r.kind).toBe('bad_debt_unpaid');
    expect(maxRoundOffWaiveNgn(500_000, 0, 0)).toBe(0);
  });
});
