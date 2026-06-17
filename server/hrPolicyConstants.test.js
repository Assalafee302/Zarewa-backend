import { describe, expect, it } from 'vitest';
import {
  defaultProbationEndIso,
  evaluateTransferTenurePolicy,
  leaveBandFromSalaryLevel,
} from './hrPolicyConstants.js';

describe('hrPolicyConstants', () => {
  it('maps salary levels to leave bands', () => {
    expect(leaveBandFromSalaryLevel(1)).toBe('junior');
    expect(leaveBandFromSalaryLevel(3)).toBe('junior');
    expect(leaveBandFromSalaryLevel(4)).toBe('senior');
    expect(leaveBandFromSalaryLevel(7)).toBe('senior');
  });

  it('computes default probation end', () => {
    expect(defaultProbationEndIso('2026-01-15')).toBe('2026-07-15');
  });

  it('warns on early branch transfer when exception allowed', () => {
    const r = evaluateTransferTenurePolicy(
      { transferType: 'inter_branch', yearsOfService: 1.5 },
      { allowException: true }
    );
    expect(r.ok).toBe(true);
    expect(r.warnings.length).toBeGreaterThan(0);
  });

  it('blocks early branch transfer without exception', () => {
    const r = evaluateTransferTenurePolicy({ transferType: 'inter_branch', yearsOfService: 1.5 });
    expect(r.ok).toBe(false);
    expect(r.blocked).toBe(true);
  });

  it('exempts branch manager from internal rotation warning', () => {
    const r = evaluateTransferTenurePolicy({
      transferType: 'in_branch_department',
      yearsOfService: 1,
      designationId: 'desig_bm',
    });
    expect(r.warnings).toHaveLength(0);
  });
});
