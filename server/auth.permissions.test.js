import { describe, expect, it } from 'vitest';
import {
  ensureSalesDeskPermissions,
  ensureStoreFloorPermissions,
  mergeRoleAndCustomPermissions,
  permissionsForRole,
  publicUserFromRow,
} from './auth.js';

describe('mergeRoleAndCustomPermissions', () => {
  it('keeps role defaults when custom JSON omits production.manage', () => {
    const merged = mergeRoleAndCustomPermissions('operations_officer', ['dashboard.view']);
    expect(merged).toContain('production.manage');
    expect(merged).toContain('operations.view');
    expect(merged).toContain('dashboard.view');
    expect(merged).not.toContain('procurement.view');
    expect(merged).not.toContain('purchase_orders.manage');
  });
});

describe('operations_officer procurement access', () => {
  it('does not include purchase module permissions by default', () => {
    const perms = permissionsForRole('operations_officer');
    expect(perms).toContain('inventory.receive');
    expect(perms).not.toContain('procurement.view');
    expect(perms).not.toContain('procurement.manage');
    expect(perms).not.toContain('purchase_orders.manage');
    expect(perms).not.toContain('suppliers.manage');
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

describe('operations_officer role aliases', () => {
  it('normalizes legacy storekeeper keys to operations_officer permissions', () => {
    const ops = permissionsForRole('operations_officer');
    expect(ops).toContain('production.manage');
    expect(ops).not.toContain('production.release');
    expect(ops).not.toContain('material_incidents.approve');
    expect(ops).toContain('operations.manage');
    expect(ops).toContain('material_incidents.create');
    expect(permissionsForRole('storekeeper')).toEqual(ops);
    expect(permissionsForRole('store_keeper')).toEqual(ops);
  });

  it('keeps production.release on branch manager, not store floor', () => {
    const bm = permissionsForRole('sales_manager');
    expect(bm).toContain('production.release');
    expect(bm).toContain('material_incidents.approve');
  });

  it('includes HR self-service so floor staff can use My Profile', () => {
    const ops = permissionsForRole('operations_officer');
    expect(ops).toContain('hr.self');
    expect(ops).toContain('hr.my_payslip.view');
  });
});

describe('publicUserFromRow role normalization', () => {
  it('returns operations_officer for legacy storekeeper logins', () => {
    const user = publicUserFromRow({
      id: 'U-SK',
      username: 'store1',
      role_key: 'storekeeper',
      department: 'storekeeper',
      permissions_json: null,
    });
    expect(user.roleKey).toBe('operations_officer');
    expect(user.roleLabel).toBe('Operations Officer (Store)');
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
    expect(user.permissions).not.toContain('procurement.view');
    expect(user.permissions).not.toContain('purchase_orders.manage');
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
