import { describe, expect, it } from 'vitest';
import { buildChampionCustomerSnippet, buildMdCockpitPulses } from './mdCockpitOps.js';

describe('mdCockpitOps', () => {
  it('buildChampionCustomerSnippet picks top payer', () => {
    const r = buildChampionCustomerSnippet([
      { customerName: 'Alpha Ltd', paidNgn: 5_000_000, branchId: 'BR-KD' },
      { customerName: 'Beta', paidNgn: 1_000_000 },
    ]);
    expect(r.champion.customerName).toBe('Alpha Ltd');
    expect(r.champion.paidNgn).toBe(5_000_000);
  });

  it('buildMdCockpitPulses returns five pulse keys', () => {
    const pulses = buildMdCockpitPulses(null, {
      limits: { expenseExecutiveThresholdNgn: 200_000 },
      branchScope: 'ALL',
        treasuryCashNgn: 10_000_000,
        outstandingReceivablesNgn: 2_000_000,
        inventoryValueNgn: 3_000_000,
        producedRevenueNgn: 8_000_000,
        targetRevenueNgn: 10_000_000,
        completedMetres: 900,
        targetMetres: 1000,
        priceExceptionCount: 0,
        payrollDraftsAwaitingMd: 0,
        workTrayItems: [],
        biPack: { inventory: { families: [{ weeksCover: 4 }] } },
      });
      expect(pulses.cash).toBeTruthy();
      expect(pulses.coil).toBeTruthy();
      expect(pulses.metres).toBeTruthy();
      expect(pulses.margin).toBeTruthy();
      expect(pulses.people).toBeTruthy();
  });
});
