import { describe, expect, it } from 'vitest';
import {
  coilDamagePreview,
  normalizeDamageLinesForPayload,
  sumDamageLineMeters,
  validateCoilDamagePayload,
} from './coilDamageRecordCore.js';

describe('coilDamageRecordCore', () => {
  it('computes preview conversion from before/after kg and metres', () => {
    const p = coilDamagePreview({ beforeKg: 4800, afterKg: 4400, meters: 150, supplierConversionKgPerM: 2.65 });
    expect(p.kgDeducted).toBe(400);
    expect(p.actualConversionKgPerM).toBeCloseTo(2.67, 2);
    expect(p.impliedMetersFromSupplier).toBeCloseTo(150.94, 1);
  });

  it('rejects invalid before/after kg', () => {
    const r = validateCoilDamagePayload({
      coilNo: 'C-1',
      beforeKg: 100,
      afterKg: 120,
      meters: 50,
      note: 'Damage section cut',
    });
    expect(r.ok).toBe(false);
  });

  it('sums metres from damaged section lines', () => {
    const lines = normalizeDamageLinesForPayload([
      { lengthM: 4.5, quantity: 10 },
      { lengthM: 2, quantity: 5 },
    ]);
    expect(lines).toHaveLength(2);
    expect(sumDamageLineMeters(lines)).toBeCloseTo(55, 2);
    const r = validateCoilDamagePayload(
      {
        coilNo: 'C-1',
        beforeKg: 100,
        afterKg: 80,
        lines,
        note: 'Two stained bands cut out',
      },
      { maxRemoveKg: 100 }
    );
    expect(r.ok).toBe(true);
    expect(r.meters).toBeCloseTo(55, 2);
  });

  it('rejects kg above unreserved max', () => {
    const r = validateCoilDamagePayload(
      {
        coilNo: 'C-1',
        beforeKg: 5000,
        afterKg: 0,
        meters: 1800,
        note: 'Too much kg removed',
      },
      { maxRemoveKg: 4500 }
    );
    expect(r.ok).toBe(false);
    expect(String(r.error)).toMatch(/unreserved/i);
  });
});
