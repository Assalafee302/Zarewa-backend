import { describe, it, expect } from 'vitest';
import {
  aggregatePaidShortfallsFromRefundLines,
  maxProducedMetresAfterPaidUnproducedRefund,
  parseAccessoryShortfallLabel,
  parseStoneFlatsheetShortfallLabel,
} from './refundPaidProductionCaps.js';

describe('refundPaidProductionCaps', () => {
  it('parses unproduced, accessory, and stone shortfall lines', () => {
    const caps = aggregatePaidShortfallsFromRefundLines([
      {
        category: 'Unproduced meterage',
        label: 'Unproduced metres (12.00m @ ₦4,800)',
        include: true,
      },
      {
        category: 'Accessory shortfall',
        label: 'Accessory shortfall: Ridge cap (5 × ₦1,200)',
        include: true,
      },
      {
        category: 'Stone flatsheet shortfall',
        label: 'Stone flatsheet shortfall: Stone flatsheet (1.4 m) — 10.00 m² × ₦8,000',
        include: true,
      },
    ]);
    expect(caps.unproducedMetres).toBe(12);
    expect(caps.accessoryShortfallByKey.get('ridge cap')).toBe(5);
    expect(caps.stoneShortfallM2ByKey.get('stone flatsheet|1.4')).toBe(10);
  });

  it('max produced metres subtracts refunded unproduced', () => {
    expect(maxProducedMetresAfterPaidUnproducedRefund(40, 12)).toBe(28);
    expect(maxProducedMetresAfterPaidUnproducedRefund(40, 0)).toBeNull();
  });

  it('parses accessory and stone labels', () => {
    expect(parseAccessoryShortfallLabel('Accessory shortfall: Drive screw (3 × ₦500)')).toEqual({
      name: 'Drive screw',
      qty: 3,
    });
    expect(
      parseStoneFlatsheetShortfallLabel(
        'Stone flatsheet shortfall: Stone flatsheet (2 m) — 4.50 m² × ₦9,000'
      )
    ).toEqual({ name: 'Stone flatsheet', lengthM: 2, shortfallM2: 4.5 });
    expect(
      parseStoneFlatsheetShortfallLabel(
        'Stone flatsheet shortfall: Ridge Cap (1.00 × 2 m) — 2.00 m²'
      )
    ).toEqual({ name: 'Ridge Cap', lengthM: 2, shortfallM2: 2, shortfallPcs: 1 });
  });
});
