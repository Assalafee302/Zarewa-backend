import { describe, expect, it } from 'vitest';
import {
  ensureSalesDeskPermissions,
  ensureStoreFloorPermissions,
  mergeRoleAndCustomPermissions,
  publicUserFromRow,
} from './auth.js';

describe('mergeRoleAndCustomPermissions', () => {
  it('keeps role defaults when custom JSON omits production.manage', () => {
    const merged = mergeRoleAndCustomPermissions('operations_officer', ['dashboard.view']);
    expect(merged).toContain('production.manage');
    expect(merged).toContain('operations.view');
    expect(merged).toContain('dashboard.view');
  });
});

describe('ensureStoreFloorPermissions', () => {
  it('grants store floor perms when department is inventory', () => {
    const perms = ['dashboard.view'];
    ensureStoreFloorPermissions(perms, { roleKey: 'sales_staff', department: 'inventory' });
    expect(perms).toContain('production.manage');
    expect(perms).toContain('inventory.receive');
  });
});

describe('ensureSalesDeskPermissions', () => {
  it('grants sales desk perms when department is sales', () => {
    const perms = ['dashboard.view'];
    ensureSalesDeskPermissions(perms, { roleKey: 'viewer', department: 'sales' });
    expect(perms).toContain('expenses.create');
    expect(perms).toContain('quotations.manage');
  });
});

describe('publicUserFromRow store floor', () => {
  it('restores production.manage for ops officer with trimmed custom JSON', () => {
    const user = publicUserFromRow({
      id: 'U1',
      username: 'store1',
      role_key: 'operations_officer',
      department: 'production',
      permissions_json: JSON.stringify(['dashboard.view', 'office.use']),
    });
    expect(user.permissions).toContain('production.manage');
    expect(user.permissions).toContain('operations.manage');
  });

  it('grants floor perms for inventory department on non-ops role', () => {
    const user = publicUserFromRow({
      id: 'U2',
      username: 'legacy',
      role_key: 'sales_staff',
      department: 'inventory',
      permissions_json: null,
    });
    expect(user.permissions).toContain('production.manage');
  });

  it('restores expenses.create for sales_staff with trimmed custom JSON', () => {
    const user = publicUserFromRow({
      id: 'U3',
      username: 'sales1',
      role_key: 'sales_staff',
      department: 'sales',
      permissions_json: JSON.stringify(['dashboard.view', 'office.use']),
    });
    expect(user.permissions).toContain('expenses.create');
    expect(user.permissions).toContain('quotations.manage');
  });
});
