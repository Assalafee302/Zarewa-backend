import { describe, expect, it } from 'vitest';
import {
  userMayViewAp1cDryRun,
  userMayViewFinanceTrialExceptions,
  userMayViewFinanceTrialOversight,
} from './financeDeskAccess.js';

describe('financeDeskAccess (server)', () => {
  it('allows cashier and finance_manager trial exception API', () => {
    expect(
      userMayViewFinanceTrialExceptions({ roleKey: 'cashier', permissions: ['cashier.desk.view'] })
    ).toBe(true);
    expect(userMayViewFinanceTrialExceptions({ roleKey: 'finance_manager', permissions: [] })).toBe(
      true
    );
  });

  it('allows MD oversight', () => {
    expect(userMayViewFinanceTrialOversight({ roleKey: 'md', permissions: [] })).toBe(true);
    expect(userMayViewFinanceTrialOversight({ roleKey: 'cashier', permissions: [] })).toBe(false);
  });

  it('AP1c dry-run excludes cashier without accounting perms', () => {
    expect(userMayViewAp1cDryRun({ roleKey: 'finance_manager', permissions: [] })).toBe(true);
    expect(userMayViewAp1cDryRun({ roleKey: 'cashier', permissions: [] })).toBe(false);
    expect(
      userMayViewAp1cDryRun({ roleKey: 'cashier', permissions: ['accounting.reconciliation.view'] })
    ).toBe(true);
  });
});
