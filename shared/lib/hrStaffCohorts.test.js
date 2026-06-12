import { describe, expect, it } from 'vitest';
import {
  HR_PAYROLL_GROUPS,
  isPayrollRunEligible,
  isStatutoryPayrollExempt,
  requiresEmployeePensionDeduction,
  requiresPaye,
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
});
