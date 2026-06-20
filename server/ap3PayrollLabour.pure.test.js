import { describe, expect, it } from 'vitest';
import { isProductionStaffProfile } from './ap3PayrollLabourOps.js';

describe('ap3PayrollLabour (pure)', () => {
  it('isProductionStaffProfile respects explicit flag', () => {
    expect(isProductionStaffProfile({ is_production_staff: 1 })).toBe(true);
    expect(isProductionStaffProfile({ is_production_staff: 0, department: 'Production' })).toBe(false);
  });

  it('isProductionStaffProfile uses department heuristic when flag unset', () => {
    expect(isProductionStaffProfile({ department: 'Factory production' })).toBe(true);
    expect(isProductionStaffProfile({ job_title: 'Machine Operator' })).toBe(true);
    expect(isProductionStaffProfile({ department: 'Admin' })).toBe(false);
  });
});
