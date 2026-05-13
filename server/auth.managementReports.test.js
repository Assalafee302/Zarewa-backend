import { describe, it, expect } from 'vitest';
import { userMayViewManagementReports, permissionsForRole } from './auth.js';

describe('userMayViewManagementReports', () => {
  it('allows finance_manager with reports.view', () => {
    const user = {
      roleKey: 'finance_manager',
      permissions: permissionsForRole('finance_manager'),
    };
    expect(user.permissions.includes('reports.view')).toBe(true);
    expect(userMayViewManagementReports(user)).toBe(true);
  });

  it('denies finance_manager without reports.view', () => {
    const user = {
      roleKey: 'finance_manager',
      permissions: permissionsForRole('finance_manager').filter((p) => p !== 'reports.view'),
    };
    expect(userMayViewManagementReports(user)).toBe(false);
  });

  it('denies operations_officer even with reports.view', () => {
    const user = {
      roleKey: 'operations_officer',
      permissions: [...permissionsForRole('operations_officer'), 'reports.view'],
    };
    expect(userMayViewManagementReports(user)).toBe(false);
  });
});
