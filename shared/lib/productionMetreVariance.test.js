import { describe, it, expect } from 'vitest';
import {
  metreVariancePct,
  metreVarianceExceedsThreshold,
  PRODUCTION_METRE_VARIANCE_WARN_PCT,
  assessProductionMetreOverrun,
} from './productionMetreVariance.js';

describe('productionMetreVariance', () => {
  it('returns null when planned is zero', () => {
    expect(metreVariancePct(0, 10)).toBeNull();
  });

  it('computes signed variance', () => {
    expect(metreVariancePct(100, 95)).toBe(-5);
    expect(metreVariancePct(100, 106)).toBe(6);
  });

  it('flags variance beyond threshold', () => {
    expect(metreVarianceExceedsThreshold(100, 94, PRODUCTION_METRE_VARIANCE_WARN_PCT)).toBe(true);
    expect(metreVarianceExceedsThreshold(100, 96, PRODUCTION_METRE_VARIANCE_WARN_PCT)).toBe(false);
    expect(metreVarianceExceedsThreshold(100, 106, PRODUCTION_METRE_VARIANCE_WARN_PCT)).toBe(true);
  });
});

describe('assessProductionMetreOverrun', () => {
  it('treats alu coil+offcut vs plannedMeters as a single bucket', () => {
    const r = assessProductionMetreOverrun({
      plannedMeters: 12,
      flatsheetMeters: 103,
    });
    expect(r.overrun).toBe(true);
    expect(r.overMeters).toBeCloseTo(91, 5);
  });

  it('does not treat stone roofing + offcut flatsheet as a roofing overrun of the roof plan', () => {
    const r = assessProductionMetreOverrun({
      stoneHybrid: true,
      plannedMeters: 423,
      plannedRoofM: 423,
      plannedFlatsheetM: 0,
      stoneMetersConsumed: 423,
      flatsheetMeters: 22,
    });
    expect(r.roofOverMeters).toBe(0);
    expect(r.flatsheetOverMeters).toBeCloseTo(22, 5);
    expect(r.overrun).toBe(true);
    expect(r.message).toMatch(/flatsheet\/offcut/i);
    expect(r.message).not.toMatch(/roofing/i);
  });

  it('allows hybrid complete when roofing and flatsheet are each within their own plan', () => {
    const r = assessProductionMetreOverrun({
      stoneHybrid: true,
      plannedMeters: 423,
      plannedRoofM: 423,
      plannedFlatsheetM: 22,
      stoneMetersConsumed: 423,
      flatsheetMeters: 22,
    });
    expect(r.overrun).toBe(false);
    expect(r.message).toBeNull();
  });
});
