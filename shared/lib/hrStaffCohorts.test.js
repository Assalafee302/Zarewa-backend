import { describe, expect, it } from 'vitest';
import {
  HR_PAYROLL_GROUPS,
  HQ_CASHIER_BRANCH_ID,
  isBeneficiaryOnlyPayrollGroup,
  isErpAccessRestrictedPayrollGroup,
  isPayrollRunEligible,
  isRefundClaimingStaffEligiblePayrollGroup,
  isStatutoryPayrollExempt,
  payrollGroupMayHaveLogin,
  requiresEmployeePensionDeduction,
  requiresPaye,
  resolveStaffCashierBranchId,
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

  it('HQ admin and mining are included in HQ payroll runs with PAYE and pension', () => {
    for (const g of [HR_PAYROLL_GROUPS.MINING, HR_PAYROLL_GROUPS.HQ_ADMIN]) {
      expect(isPayrollRunEligible(g)).toBe(true);
      expect(requiresPaye(g)).toBe(true);
      expect(requiresEmployeePensionDeduction(g)).toBe(true);
      expect(isStatutoryPayrollExempt(g)).toBe(false);
    }
  });

  it('scholarship and domestic are exempt from HQ payroll runs', () => {
    for (const g of [HR_PAYROLL_GROUPS.SCHOLARSHIP, HR_PAYROLL_GROUPS.DOMESTIC]) {
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

  it('excludes chairman, scholarship, and mining from refund claiming staff', () => {
    expect(isRefundClaimingStaffEligiblePayrollGroup(HR_PAYROLL_GROUPS.BRANCH_OPS)).toBe(true);
    expect(isRefundClaimingStaffEligiblePayrollGroup(HR_PAYROLL_GROUPS.HQ_ADMIN)).toBe(true);
    expect(isRefundClaimingStaffEligiblePayrollGroup(HR_PAYROLL_GROUPS.DOMESTIC)).toBe(false);
    expect(isRefundClaimingStaffEligiblePayrollGroup(HR_PAYROLL_GROUPS.SCHOLARSHIP)).toBe(false);
    expect(isRefundClaimingStaffEligiblePayrollGroup(HR_PAYROLL_GROUPS.MINING)).toBe(false);
    expect(isRefundClaimingStaffEligiblePayrollGroup('scholaship')).toBe(false);
  });

  it('beneficiary payroll groups cannot have ERP logins', () => {
    for (const g of [HR_PAYROLL_GROUPS.SCHOLARSHIP, HR_PAYROLL_GROUPS.DOMESTIC]) {
      expect(isBeneficiaryOnlyPayrollGroup(g)).toBe(true);
      expect(payrollGroupMayHaveLogin(g)).toBe(false);
    }
    for (const g of [HR_PAYROLL_GROUPS.BRANCH_OPS, HR_PAYROLL_GROUPS.HQ_ADMIN, HR_PAYROLL_GROUPS.MINING]) {
      expect(payrollGroupMayHaveLogin(g)).toBe(true);
    }
  });

  it('only mining is ERP-access restricted', () => {
    expect(isErpAccessRestrictedPayrollGroup(HR_PAYROLL_GROUPS.MINING)).toBe(true);
    expect(isErpAccessRestrictedPayrollGroup(HR_PAYROLL_GROUPS.SCHOLARSHIP)).toBe(false);
    expect(isErpAccessRestrictedPayrollGroup(HR_PAYROLL_GROUPS.DOMESTIC)).toBe(false);
    expect(isErpAccessRestrictedPayrollGroup(HR_PAYROLL_GROUPS.BRANCH_OPS)).toBe(false);
    expect(isErpAccessRestrictedPayrollGroup(HR_PAYROLL_GROUPS.HQ_ADMIN)).toBe(false);
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

  it('resolveStaffCashierBranchId uses host branch or Kaduna HQ default', () => {
    expect(resolveStaffCashierBranchId({ branch_id: 'BR-YL', payroll_group: 'branch_ops' })).toBe('BR-YL');
    expect(resolveStaffCashierBranchId({ payroll_group: 'hq_admin' })).toBe(HQ_CASHIER_BRANCH_ID);
    expect(resolveStaffCashierBranchId({ payroll_group: 'mining_div' })).toBe(HQ_CASHIER_BRANCH_ID);
    expect(resolveStaffCashierBranchId({ branch_id: 'BR-YL', payroll_group: 'chairman_staffs' })).toBe('BR-YL');
    expect(resolveStaffCashierBranchId({ payroll_group: 'chairman_staffs' })).toBe(HQ_CASHIER_BRANCH_ID);
  });
});
