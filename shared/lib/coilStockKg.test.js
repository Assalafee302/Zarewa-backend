import { describe, expect, it } from 'vitest';
import { coilFreeKg, coilKgUsed, coilOnHandKg, coilReceivedKg } from './coilStockKg.js';

describe('coilStockKg', () => {
  it('uses GRN weight when live on-hand fields are absent', () => {
    const lot = { weightKg: 3540, qtyReceived: 3540 };
    expect(coilReceivedKg(lot)).toBe(3540);
    expect(coilOnHandKg(lot)).toBe(3540);
    expect(coilKgUsed(lot)).toBe(0);
  });

  it('returns zero on-hand for consumed coil (does not fall back to GRN)', () => {
    const lot = {
      weightKg: 3540,
      qtyReceived: 3540,
      qtyRemaining: 0,
      currentWeightKg: 0,
      currentStatus: 'Consumed',
    };
    expect(coilOnHandKg(lot)).toBe(0);
    expect(coilKgUsed(lot)).toBe(3540);
    expect(coilFreeKg(lot)).toBe(0);
  });

  it('prefers live on-hand over GRN when partially used', () => {
    const lot = { weightKg: 3540, qtyRemaining: 495, currentWeightKg: 495 };
    expect(coilOnHandKg(lot)).toBe(495);
    expect(coilKgUsed(lot)).toBe(3045);
  });
});
