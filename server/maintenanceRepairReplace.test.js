import { describe, expect, it } from 'vitest';
import {
  REPAIR_REPLACE_PCT_OF_COST,
  REPAIR_WATCH_PCT_OF_COST,
  repairReplaceFlag,
  repairReplaceLabel,
} from '../shared/maintenanceRepairReplace.js';

describe('repairReplaceFlag', () => {
  it('returns ok when little or no spend', () => {
    expect(
      repairReplaceFlag({ lifetimeMaintenanceNgn: 0, costNgn: 10_000_000, netBookValueNgn: 5_000_000 })
    ).toBe('ok');
    expect(
      repairReplaceFlag({
        lifetimeMaintenanceNgn: 1_000_000,
        costNgn: 10_000_000,
        netBookValueNgn: 5_000_000,
      })
    ).toBe('ok'); // 10% < 40%
  });

  it('watches at 40% of cost', () => {
    expect(REPAIR_WATCH_PCT_OF_COST).toBe(40);
    expect(
      repairReplaceFlag({
        lifetimeMaintenanceNgn: 4_000_000,
        costNgn: 10_000_000,
        netBookValueNgn: 8_000_000,
      })
    ).toBe('watch');
  });

  it('replace_review at 70% of cost or 100% of NBV', () => {
    expect(REPAIR_REPLACE_PCT_OF_COST).toBe(70);
    expect(
      repairReplaceFlag({
        lifetimeMaintenanceNgn: 7_000_000,
        costNgn: 10_000_000,
        netBookValueNgn: 8_000_000,
      })
    ).toBe('replace_review');
    expect(
      repairReplaceFlag({
        lifetimeMaintenanceNgn: 2_000_000,
        costNgn: 10_000_000,
        netBookValueNgn: 2_000_000,
      })
    ).toBe('replace_review'); // 100% of NBV
  });

  it('urgent when floor flagged replacement', () => {
    expect(
      repairReplaceFlag({
        lifetimeMaintenanceNgn: 100,
        costNgn: 10_000_000,
        netBookValueNgn: 5_000_000,
        replacementRequired: true,
      })
    ).toBe('urgent');
    expect(repairReplaceLabel('urgent')).toMatch(/Replacement/i);
  });
});
