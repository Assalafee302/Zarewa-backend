import { describe, expect, it } from 'vitest';
import {
  getAllowedLegacyAccountTabs,
  resolveLegacyAccountsRedirect,
  userMayAccessAccountingGlApis,
  userMayAccessLegacyAccountsRoute,
} from './legacyAccountsAccess.js';

describe('legacyAccountsAccess', () => {
  const bm = { roleKey: 'sales_manager', permissions: ['finance.approve', 'reports.view'] };
  const cashier = { roleKey: 'cashier', permissions: ['cashier.desk.view', 'finance.view', 'finance.pay'] };
  const accountant = {
    roleKey: 'finance_manager',
    permissions: ['accounting.desk.view', 'finance.view', 'reports.view'],
  };
  const md = { roleKey: 'md', permissions: ['finance.view', 'accounting.desk.view'] };

  it('branch manager cannot access legacy accounts route', () => {
    expect(userMayAccessLegacyAccountsRoute(bm)).toBe(false);
    expect(resolveLegacyAccountsRedirect(bm)?.to).toBe('/manager');
  });

  it('cashier role can open Finance desk even without desk permission keys', () => {
    expect(userMayAccessLegacyAccountsRoute({ roleKey: 'cashier', permissions: [] })).toBe(true);
    expect(resolveLegacyAccountsRedirect({ roleKey: 'cashier', permissions: [] })).toBeNull();
  });

  it('cashier can access route with desk tab but not audit', () => {
    expect(userMayAccessLegacyAccountsRoute(cashier)).toBe(true);
    expect(getAllowedLegacyAccountTabs(cashier)).toContain('desk');
    expect(getAllowedLegacyAccountTabs(cashier)).not.toContain('audit');
    expect(resolveLegacyAccountsRedirect(cashier, 'audit')?.to).toBe('/accounts?tab=desk');
    expect(getAllowedLegacyAccountTabs(cashier)).toContain('disbursements');
  });

  it('accountant can access audit tab', () => {
    expect(userMayAccessLegacyAccountsRoute(accountant)).toBe(true);
    expect(getAllowedLegacyAccountTabs(accountant)).toContain('audit');
  });

  it('cashier and BM blocked from GL APIs', () => {
    expect(userMayAccessAccountingGlApis(cashier)).toBe(false);
    expect(userMayAccessAccountingGlApis(bm)).toBe(false);
    expect(userMayAccessAccountingGlApis(accountant)).toBe(true);
    expect(userMayAccessAccountingGlApis(md)).toBe(true);
  });
});
