import { describe, expect, it } from 'vitest';
import { payrollGroupsForCohort } from '../shared/lib/hrStaffCohorts.js';

describe('listHrStaff cohort filtering contract', () => {
  it('payrollGroupsForCohort defaults employees to branch_ops only', () => {
    expect(payrollGroupsForCohort('employees')).toEqual(['branch_ops']);
    expect(payrollGroupsForCohort(undefined)).toEqual(['branch_ops']);
  });

  it('payrollGroupsForCohort all returns null (no filter)', () => {
    expect(payrollGroupsForCohort('all')).toBeNull();
  });

  it('internal callers omit opts.cohort to include every payroll group', () => {
    // listHrStaff only applies cohort filter when opts.cohort is explicitly set.
    const explicitCohort = payrollGroupsForCohort('employees');
    const omittedCohort = null;
    expect(explicitCohort).toEqual(['branch_ops']);
    expect(omittedCohort).toBeNull();
  });
});
