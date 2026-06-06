import { describe, expect, it } from 'vitest';
import { calculateEligibleOvertime, calculateWorkedHours } from './hrPhase2Ops.js';

describe('hrPhase2Ops overtime', () => {
  it('calculates worked hours from start/end', () => {
    expect(calculateWorkedHours('08:00', '17:00')).toBe(9);
    expect(calculateWorkedHours('09:00', '18:30')).toBe(9.5);
  });

  it('applies weekday overtime threshold of 9 hours', () => {
    const r = calculateEligibleOvertime('2026-06-03', '08:00', '19:00'); // Wednesday
    expect(r.calculatedHours).toBe(11);
    expect(r.eligibleOvertimeHours).toBe(2);
    expect(r.specialSundayOvertime).toBe(false);
  });

  it('applies Saturday overtime threshold of 7 hours', () => {
    const r = calculateEligibleOvertime('2026-06-06', '09:00', '18:00'); // Saturday
    expect(r.calculatedHours).toBe(9);
    expect(r.eligibleOvertimeHours).toBe(2);
  });

  it('marks Sunday as special overtime', () => {
    const r = calculateEligibleOvertime('2026-06-07', '10:00', '14:00');
    expect(r.specialSundayOvertime).toBe(true);
    expect(r.eligibleOvertimeHours).toBe(4);
  });
});
