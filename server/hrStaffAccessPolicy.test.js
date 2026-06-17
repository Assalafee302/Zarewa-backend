import { describe, expect, it } from 'vitest';
import { HR_PAYROLL_GROUPS } from '../shared/lib/hrStaffCohorts.js';
import {
  HR_PORTAL_ONLY_ROLE_KEY,
  defaultRoleKeyForPayrollGroup,
  enforcePortalOnlyRole,
  validateStaffRoleForPayrollGroup,
} from './hrStaffAccessPolicy.js';

describe('hrStaffAccessPolicy', () => {
  it('defaults restricted payroll groups to portal-only role', () => {
    expect(defaultRoleKeyForPayrollGroup(HR_PAYROLL_GROUPS.DOMESTIC)).toBe(HR_PORTAL_ONLY_ROLE_KEY);
    expect(defaultRoleKeyForPayrollGroup(HR_PAYROLL_GROUPS.SCHOLARSHIP)).toBe(HR_PORTAL_ONLY_ROLE_KEY);
    expect(defaultRoleKeyForPayrollGroup(HR_PAYROLL_GROUPS.MINING)).toBe(HR_PORTAL_ONLY_ROLE_KEY);
    expect(defaultRoleKeyForPayrollGroup(HR_PAYROLL_GROUPS.BRANCH_OPS)).toBe('sales_staff');
  });

  it('rejects ERP roles for restricted payroll groups', () => {
    for (const pg of [HR_PAYROLL_GROUPS.DOMESTIC, HR_PAYROLL_GROUPS.SCHOLARSHIP, HR_PAYROLL_GROUPS.MINING]) {
      expect(validateStaffRoleForPayrollGroup('sales_staff', pg).ok).toBe(false);
      expect(validateStaffRoleForPayrollGroup(HR_PORTAL_ONLY_ROLE_KEY, pg).ok).toBe(true);
    }
    expect(validateStaffRoleForPayrollGroup('sales_staff', HR_PAYROLL_GROUPS.BRANCH_OPS).ok).toBe(true);
  });

  it('enforcePortalOnlyRole rewrites operational roles', () => {
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
    const r = enforcePortalOnlyRole(db, 'USR-1', HR_PAYROLL_GROUPS.DOMESTIC);
    expect(r.ok).toBe(true);
    expect(r.changed).toBe(true);
    expect(db.lastUpdate[0]).toBe(HR_PORTAL_ONLY_ROLE_KEY);
  });
});
