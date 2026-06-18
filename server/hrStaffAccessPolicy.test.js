import { describe, expect, it } from 'vitest';
import { HR_PAYROLL_GROUPS } from '../shared/lib/hrStaffCohorts.js';
import {
  BENEFICIARY_NO_LOGIN_ERROR,
  HR_PORTAL_ONLY_ROLE_KEY,
  defaultRoleKeyForPayrollGroup,
  enforcePortalOnlyRole,
  validatePayrollGroupMayHaveLogin,
  validateStaffRoleForPayrollGroup,
} from './hrStaffAccessPolicy.js';

describe('hrStaffAccessPolicy', () => {
  it('rejects login for beneficiary payroll groups', () => {
    for (const pg of [HR_PAYROLL_GROUPS.DOMESTIC, HR_PAYROLL_GROUPS.SCHOLARSHIP]) {
      expect(validatePayrollGroupMayHaveLogin(pg).ok).toBe(false);
      expect(validateStaffRoleForPayrollGroup('hr_portal_only', pg).ok).toBe(false);
      expect(defaultRoleKeyForPayrollGroup(pg)).toBeNull();
    }
    expect(validatePayrollGroupMayHaveLogin(HR_PAYROLL_GROUPS.BRANCH_OPS).ok).toBe(true);
  });

  it('defaults mining to portal-only role', () => {
    expect(defaultRoleKeyForPayrollGroup(HR_PAYROLL_GROUPS.MINING)).toBe(HR_PORTAL_ONLY_ROLE_KEY);
    expect(defaultRoleKeyForPayrollGroup(HR_PAYROLL_GROUPS.BRANCH_OPS)).toBe('sales_staff');
  });

  it('rejects ERP roles for mining payroll group', () => {
    expect(validateStaffRoleForPayrollGroup('sales_staff', HR_PAYROLL_GROUPS.MINING).ok).toBe(false);
    expect(validateStaffRoleForPayrollGroup(HR_PORTAL_ONLY_ROLE_KEY, HR_PAYROLL_GROUPS.MINING).ok).toBe(true);
    expect(validateStaffRoleForPayrollGroup('sales_staff', HR_PAYROLL_GROUPS.BRANCH_OPS).ok).toBe(true);
  });

  it('enforcePortalOnlyRole rewrites operational roles for mining', () => {
    const db = {
      prepare(sql) {
        const s = String(sql);
        if (s.includes('SELECT role_key')) {
          return {
            get: () => ({ roleKey: 'sales_staff', permissionsJson: null }),
          };
        }
        if (s.includes('UPDATE app_users')) {
          return { run: (...args) => { db.lastUpdate = args; } };
        }
        return { get: () => null, run: () => {} };
      },
    };
    const r = enforcePortalOnlyRole(db, 'USR-1', HR_PAYROLL_GROUPS.MINING);
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(true);
    expect(db.lastUpdate[0]).toBe(HR_PORTAL_ONLY_ROLE_KEY);
  });

  it('beneficiary error message guides to Chairman Accounts', () => {
    expect(BENEFICIARY_NO_LOGIN_ERROR).toMatch(/Chairman Accounts/i);
  });
});
