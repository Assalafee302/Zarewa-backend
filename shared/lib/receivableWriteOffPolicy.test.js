import { describe, expect, it } from 'vitest';
import {
  evaluateReceivableWriteOff,
  maxRoundOffWaiveNgn,
  registerReceivableOutstandingNgn,
  roundOffToleranceNgn,
} from './receivableWriteOffPolicy.js';

describe('receivableWriteOffPolicy', () => {
  it('roundOffToleranceNgn caps at 5000', () => {
    expect(roundOffToleranceNgn(1_000_000)).toBe(5000);
    expect(roundOffToleranceNgn(10_000)).toBeLessThanOrEqual(5000);
  });

  it('allows round-off only when effectively fully paid', () => {
    expect(maxRoundOffWaiveNgn(1_250_300, 1_250_000, 0)).toBe(300);
    expect(maxRoundOffWaiveNgn(1_000_000, 900_000, 0)).toBe(0);
  });

  it('registerReceivableOutstandingNgn hides immaterial round-off', () => {
    expect(registerReceivableOutstandingNgn(1_250_300, 1_250_000, 0)).toBe(0);
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
