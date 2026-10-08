import { describe, expect, it } from 'vitest';
import {
  factorForUnit,
  formatQtyBothUnits,
  fromBaseQty,
  qtyToBase,
  toBaseQty,
} from './productUom.js';

describe('productUom', () => {
  const drivePacks = [
    { unitCode: 'pack', factorToBase: 1, active: true },
    { unitCode: 'carton', factorToBase: 30, label: 'carton', active: true },
  ];
  const tapping = [
    { unitCode: 'piece', factorToBase: 1, active: true },
    { unitCode: 'pcs', factorToBase: 1, active: true },
    { unitCode: 'carton_2_5', factorToBase: 1250, label: 'carton 2.5"', active: true },
    { unitCode: 'carton_3', factorToBase: 1000, label: 'carton 3"', active: true },
  ];

  it('round-trips carton ↔ pack for drive screws', () => {
    const base = qtyToBase(2, 'carton', 'pack', drivePacks);
    expect(base).toBe(60);
    expect(fromBaseQty(base, 30)).toBe(2);
    expect(formatQtyBothUnits(2, 'carton', 'pack', drivePacks)).toBe('2 carton = 60 pack');
  });

  it('round-trips tapping screw carton sizes to pieces', () => {
    expect(qtyToBase(1, 'carton_2_5', 'piece', tapping)).toBe(1250);
    expect(qtyToBase(1, 'carton_3', 'pcs', tapping)).toBe(1000);
    expect(toBaseQty(3, factorForUnit('carton_3', 'pcs', tapping))).toBe(3000);
  });

  it('treats base unit as factor 1', () => {
    expect(factorForUnit('pack', 'pack', drivePacks)).toBe(1);
    expect(qtyToBase(12, 'pack', 'pack', drivePacks)).toBe(12);
  });
});
