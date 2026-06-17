import { describe, it, expect } from 'vitest';
import {
  mergeRoleAndCustomPermissions,
  validatePermissionGrant,
  assertActorMayAssignRoleKey,
} from './auth.js';

describe('security hardening — permissions', () => {
  it('mergeRoleAndCustomPermissions ignores wildcard in custom JSON for non-admin roles', () => {
    const perms = mergeRoleAndCustomPermissions('sales_staff', ['*', 'settings.manage']);
    expect(perms.includes('*')).toBe(false);
    expect(perms.includes('settings.manage')).toBe(true);
    expect(perms.includes('quotations.manage')).toBe(true);
  });

  it('validatePermissionGrant rejects wildcard and requires settings.manage', () => {
    const salesManager = {
      id: 'bm1',
      roleKey: 'sales_manager',
      permissions: mergeRoleAndCustomPermissions('sales_manager', []),
    };
    expect(validatePermissionGrant(salesManager, ['reports.view']).ok).toBe(false);
    expect(validatePermissionGrant(salesManager, ['*']).ok).toBe(false);

    const admin = { id: 'a1', roleKey: 'admin', permissions: ['*', 'settings.manage'] };
    expect(validatePermissionGrant(admin, ['quotations.manage']).ok).toBe(true);
    expect(validatePermissionGrant(admin, ['*']).ok).toBe(false);
    expect(validatePermissionGrant(admin, ['INVALID PERM']).ok).toBe(false);
  });

  it('validatePermissionGrant hr mode allows hr.staff.manage without settings.manage', () => {
    const hrAdmin = {
      id: 'hr1',
      roleKey: 'hr_admin',
      permissions: mergeRoleAndCustomPermissions('hr_admin', []),
    };
    expect(validatePermissionGrant(hrAdmin, ['hr.directory.view'], { mode: 'hr' }).ok).toBe(true);
    expect(
      validatePermissionGrant(hrAdmin, ['settings.manage'], { mode: 'hr' }).ok
    ).toBe(false);
  });

  it('assertActorMayAssignRoleKey blocks admin assignment without settings.manage', () => {
    const hrAdmin = {
      id: 'hr1',
      roleKey: 'hr_admin',
      permissions: mergeRoleAndCustomPermissions('hr_admin', []),
    };
    expect(assertActorMayAssignRoleKey(hrAdmin, 'admin').ok).toBe(false);
    expect(assertActorMayAssignRoleKey(hrAdmin, 'sales_staff').ok).toBe(true);
  });
});
