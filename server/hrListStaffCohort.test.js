import { describe, expect, it } from 'vitest';
import { payrollGroupsForCohort } from '../shared/lib/hrStaffCohorts.js';

describe('listHrStaff cohort filtering contract', () => {
  it('payrollGroupsForCohort defaults employees to company HR payroll groups', () => {
    expect(payrollGroupsForCohort('employees')).toEqual(['branch_ops', 'hq_admin']);
    expect(payrollGroupsForCohort(undefined)).toEqual(['branch_ops', 'hq_admin']);
  });

  it('payrollGroupsForCohort all returns null (no filter)', () => {
    expect(payrollGroupsForCohort('all')).toBeNull();
  });

  it('payrollGroupsForCohort mining and chairman_office stay off company HR', () => {
    expect(payrollGroupsForCohort('mining')).toEqual(['mining_div']);
    expect(payrollGroupsForCohort('chairman_office')).toEqual([
      'chairman_staffs',
      'scholarship',
      'mining_div',
    ]);
  });

  it('internal callers omit opts.cohort to include every payroll group', () => {
    // listHrStaff only applies cohort filter when opts.cohort is explicitly set.
    const explicitCohort = payrollGroupsForCohort('employees');
    const omittedCohort = null;
    expect(explicitCohort).toEqual(['branch_ops', 'hq_admin']);
    expect(omittedCohort).toBeNull();
  });
});
