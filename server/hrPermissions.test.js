import { describe, expect, it } from 'vitest';
import {
  userCanAccessHrModule,
  userCanViewOrgSensitiveHr,
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
});
