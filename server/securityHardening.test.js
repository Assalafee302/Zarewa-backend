import { describe, it, expect } from 'vitest';
import {
  mergeRoleAndCustomPermissions,
  validatePermissionGrant,
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
});
