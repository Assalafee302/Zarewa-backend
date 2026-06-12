import { describe, expect, it } from 'vitest';
import {
  HR_PAYROLL_GROUPS,
  isPayrollRunEligible,
  isStatutoryPayrollExempt,
  requiresEmployeePensionDeduction,
  requiresPaye,
  staffMeetsPensionPolicy,
  usesExecutiveBenefitsMonthlyPay,
} from './hrStaffCohorts.js';

describe('hrStaffCohorts payroll rules', () => {
  it('branch staff are payroll-run eligible with PAYE and pension', () => {
    expect(isPayrollRunEligible(HR_PAYROLL_GROUPS.BRANCH_OPS)).toBe(true);
    expect(requiresPaye(HR_PAYROLL_GROUPS.BRANCH_OPS)).toBe(true);
    expect(requiresEmployeePensionDeduction(HR_PAYROLL_GROUPS.BRANCH_OPS)).toBe(true);
    expect(isStatutoryPayrollExempt(HR_PAYROLL_GROUPS.BRANCH_OPS)).toBe(false);
  });

  it('scholarship, mining, HQ, and domestic are exempt from branch payroll', () => {
    for (const g of [
      HR_PAYROLL_GROUPS.SCHOLARSHIP,
      HR_PAYROLL_GROUPS.MINING,
      HR_PAYROLL_GROUPS.HQ_ADMIN,
      HR_PAYROLL_GROUPS.DOMESTIC,
    ]) {
      expect(isPayrollRunEligible(g)).toBe(false);
      expect(requiresPaye(g)).toBe(false);
      expect(requiresEmployeePensionDeduction(g)).toBe(false);
      expect(isStatutoryPayrollExempt(g)).toBe(true);
    }
  });

  it('scholarship and domestic use executive benefits monthly pay', () => {
    expect(usesExecutiveBenefitsMonthlyPay(HR_PAYROLL_GROUPS.SCHOLARSHIP)).toBe(true);
    expect(usesExecutiveBenefitsMonthlyPay(HR_PAYROLL_GROUPS.DOMESTIC)).toBe(true);
    expect(usesExecutiveBenefitsMonthlyPay(HR_PAYROLL_GROUPS.BRANCH_OPS)).toBe(false);
  });

  it('branch staff meet pension policy unless explicitly exempt', () => {
    expect(staffMeetsPensionPolicy({ payrollGroup: HR_PAYROLL_GROUPS.BRANCH_OPS })).toBe(true);
    expect(
      staffMeetsPensionPolicy({
        payrollGroup: HR_PAYROLL_GROUPS.BRANCH_OPS,
        profileExtraJson: { statutory: { pensionExempt: true } },
      })
    ).toBe(false);
    expect(staffMeetsPensionPolicy({ payrollGroup: HR_PAYROLL_GROUPS.DOMESTIC })).toBe(false);
  });
});
