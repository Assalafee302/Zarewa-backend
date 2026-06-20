import { describe, expect, it } from 'vitest';

function branchContributionMargin(revenueNgn, factoryCostNgn) {
  const rev = Math.round(Number(revenueNgn) || 0);
  const cost = Math.round(Number(factoryCostNgn) || 0);
  const contribution = rev - cost;
  const marginPct = rev > 0 ? Math.round((contribution / rev) * 1000) / 10 : null;
  return { contributionNgn: contribution, marginPct };
}

describe('ap3BranchPl (pure)', () => {
  it('branchContributionMargin computes contribution and margin', () => {
    const r = branchContributionMargin(10_000_000, 7_500_000);
    expect(r.contributionNgn).toBe(2_500_000);
    expect(r.marginPct).toBe(25);
  });

  it('branchContributionMargin handles zero revenue', () => {
    const r = branchContributionMargin(0, 100_000);
    expect(r.contributionNgn).toBe(-100_000);
    expect(r.marginPct).toBeNull();
  });
});
