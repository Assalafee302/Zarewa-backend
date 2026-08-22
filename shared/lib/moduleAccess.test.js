import { describe, it, expect } from 'vitest';
import {
  canAccessModuleWithPermissions,
  MODULE_ACCESS_POLICY,
  userMayAccessSalesModule,
} from './moduleAccess.js';

describe('moduleAccess', () => {
  it('audit.view does not grant settings access', () => {
    expect(canAccessModuleWithPermissions(['audit.view'], 'settings')).toBe(false);
  });

  it('settings.view grants settings access', () => {
    expect(canAccessModuleWithPermissions(['settings.view'], 'settings')).toBe(true);
  });

  it('period.manage grants settings access', () => {
    expect(canAccessModuleWithPermissions(['period.manage'], 'settings')).toBe(true);
  });

  it('keeps an explicit policy list for each controlled module', () => {
    expect(Array.isArray(MODULE_ACCESS_POLICY.sales)).toBe(true);
    expect(MODULE_ACCESS_POLICY.finance.length).toBeGreaterThan(0);
  });

  it('finance permissions grant finance module; unknown module keys are denied', () => {
    expect(canAccessModuleWithPermissions(['finance.view'], 'finance')).toBe(true);
    expect(canAccessModuleWithPermissions(['finance.view'], 'legacy_hr')).toBe(false);
  });

  it('cashier_desk and accounting_desk module keys', () => {
    expect(canAccessModuleWithPermissions(['cashier.desk.view'], 'cashier_desk')).toBe(true);
    expect(canAccessModuleWithPermissions(['accounting.desk.view'], 'accounting_desk')).toBe(true);
    expect(canAccessModuleWithPermissions(['sales.view'], 'cashier_desk')).toBe(false);
  });

  it('hr module requires HR permissions', () => {
    expect(canAccessModuleWithPermissions(['hr.directory.view'], 'hr')).toBe(true);
    expect(canAccessModuleWithPermissions(['sales.view'], 'hr')).toBe(false);
    expect(canAccessModuleWithPermissions(['hr.payroll.md_approve'], 'hr')).toBe(false);
    expect(canAccessModuleWithPermissions(['hr.executive.view'], 'executive_hr')).toBe(true);
    expect(canAccessModuleWithPermissions(['hr.team.view'], 'team_hr')).toBe(true);
    expect(canAccessModuleWithPermissions(['hr.self'], 'my_profile_hr')).toBe(true);
    expect(canAccessModuleWithPermissions(['hr.directory.view'], 'my_profile_hr')).toBe(true);
    expect(canAccessModuleWithPermissions(['hr.team.view'], 'my_profile_hr')).toBe(true);
  });

  it('dashboard.view enables edit approvals visibility', () => {
    expect(canAccessModuleWithPermissions(['dashboard.view'], 'edit_approvals')).toBe(true);
  });

  it('cashier cannot open Sales module even with receipts.post', () => {
    expect(userMayAccessSalesModule('cashier', ['receipts.post', 'sales.view'])).toBe(false);
    expect(userMayAccessSalesModule('sales_staff', ['sales.view'])).toBe(true);
  });
});
