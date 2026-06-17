import { describe, expect, it } from 'vitest';
import { mergeRoleAndCustomPermissions, permissionsForRole } from './auth.js';
import {
  hrApiPathAllowedWithoutMainWorkspace,
  hrUserHas,
  userCanAccessExecutiveHrModule,
  userCanAccessHrModule,
  userCanAccessMainHrWorkspace,
  userCanAccessScholarshipDomesticExecutive,
  userCanManageExecutiveBenefits,
  userCanManageScholarshipDomesticRegisters,
  userCanViewExecutiveBenefits,
  userCanViewOrgSensitiveHr,
  userCanViewScholarshipDomesticRegisters,
  userCanViewStaffCompensation,
} from './hrPermissions.js';

describe('hrPermissions', () => {
  const branchManager = {
    id: 'USR-BM',
    roleKey: 'sales_manager',
    permissions: ['hr.team.view', 'hr.leave.endorse'],
  };
  const hrAdmin = {
    id: 'USR-HR',
    roleKey: 'hr_admin',
    permissions: ['hr.staff.manage', 'hr.payroll.view_sensitive'],
  };
  const staff = {
    id: 'USR-SS',
    roleKey: 'sales_staff',
    permissions: ['hr.self', 'hr.my_payslip.view'],
  };

  it('branch manager cannot access full HR module or org-sensitive pay', () => {
    expect(userCanAccessHrModule(branchManager)).toBe(false);
    expect(userCanViewOrgSensitiveHr(branchManager)).toBe(false);
  });

  it('HR admin can access module and sensitive compensation', () => {
    expect(userCanAccessHrModule(hrAdmin)).toBe(true);
    expect(userCanViewOrgSensitiveHr(hrAdmin)).toBe(true);
  });

  it('staff sees own compensation only after sensitive unlock', () => {
    expect(userCanViewStaffCompensation(staff, 'USR-SS', { sensitiveUnlocked: false })).toBe(false);
    expect(userCanViewStaffCompensation(staff, 'USR-SS', { sensitiveUnlocked: true })).toBe(true);
    expect(userCanViewStaffCompensation(staff, 'USR-OTHER', { sensitiveUnlocked: true })).toBe(false);
  });

  it('MD executive-only does not unlock main HR workspace', () => {
    const md = {
      id: 'USR-MD',
      roleKey: 'md',
      permissions: ['hr.executive.view', 'hr.payroll.md_approve'],
    };
    expect(userCanAccessExecutiveHrModule(md)).toBe(true);
    expect(userCanAccessMainHrWorkspace(md)).toBe(false);
    expect(userCanAccessHrModule(md)).toBe(false);
  });

  it('team and self API paths allowed without main HR workspace', () => {
    expect(hrApiPathAllowedWithoutMainWorkspace('/api/hr/my/discipline-cases', { selfUser: true })).toBe(true);
    expect(hrApiPathAllowedWithoutMainWorkspace('/api/hr/me/profile', { selfUser: true })).toBe(true);
    expect(hrApiPathAllowedWithoutMainWorkspace('/api/hr/me/scholarship-summary', { selfUser: true })).toBe(true);
    expect(hrApiPathAllowedWithoutMainWorkspace('/api/hr/me/attendance-summary', { selfUser: true })).toBe(true);
    expect(hrApiPathAllowedWithoutMainWorkspace('/api/hr/leave/calendar', { selfUser: true })).toBe(true);
    expect(hrApiPathAllowedWithoutMainWorkspace('/api/hr/staff/USR-SS/loan-schedule', { selfUser: true })).toBe(true);
    expect(hrApiPathAllowedWithoutMainWorkspace('/api/hr/payslips', { selfUser: true })).toBe(true);
    expect(hrApiPathAllowedWithoutMainWorkspace('/api/hr/templates/guarantor-form', { selfUser: true })).toBe(true);
    expect(hrApiPathAllowedWithoutMainWorkspace('/api/hr/team/summary', { teamUser: true })).toBe(true);
    expect(hrApiPathAllowedWithoutMainWorkspace('/api/hr/payroll-runs', { teamUser: true })).toBe(false);
    expect(hrApiPathAllowedWithoutMainWorkspace('/api/hr/dashboard', { selfUser: true })).toBe(false);
  });

  it('CEO and Chairman get scholarship, domestic staff, and executive benefits access', () => {
    for (const roleKey of ['ceo', 'chairman']) {
      const user = { id: `USR-${roleKey}`, roleKey, permissions: permissionsForRole(roleKey) };
      expect(userCanAccessHrModule(user)).toBe(true);
      expect(userCanAccessMainHrWorkspace(user)).toBe(true);
      expect(userCanViewExecutiveBenefits(user)).toBe(true);
      expect(userCanManageExecutiveBenefits(user)).toBe(true);
      expect(userCanAccessScholarshipDomesticExecutive(user)).toBe(true);
      expect(userCanViewScholarshipDomesticRegisters(user)).toBe(true);
      expect(userCanManageScholarshipDomesticRegisters(user)).toBe(true);
      expect(userCanViewOrgSensitiveHr(user)).toBe(true);
    }
  });

  it('executive scholarship API paths allowed without main HR workspace', () => {
    expect(
      hrApiPathAllowedWithoutMainWorkspace('/api/hr/staff', {
        executiveScholarshipDomesticUser: true,
      })
    ).toBe(true);
    expect(
      hrApiPathAllowedWithoutMainWorkspace('/api/hr/executive/beneficiaries', {
        executiveScholarshipDomesticUser: true,
      })
    ).toBe(true);
    expect(
      hrApiPathAllowedWithoutMainWorkspace('/api/hr/payroll-runs', {
        executiveScholarshipDomesticUser: true,
      })
    ).toBe(false);
  });
});

describe('hrPermissions wildcard', () => {
  it('hrUserHas treats hr.* as any hr permission prefix', () => {
    const hrAdmin = {
      roleKey: 'hr_admin',
      permissions: mergeRoleAndCustomPermissions('hr_admin', []),
    };
    expect(hrUserHas(hrAdmin, 'hr.*')).toBe(true);
    expect(hrUserHas(hrAdmin, 'hr.staff.manage')).toBe(true);
    expect(hrUserHas(hrAdmin, 'finance.post')).toBe(false);
  });

  it('hrUserHas hr.* is false for users without hr permissions', () => {
    const cashier = {
      roleKey: 'cashier',
      permissions: mergeRoleAndCustomPermissions('cashier', []),
    };
    expect(hrUserHas(cashier, 'hr.*')).toBe(false);
  });
});
