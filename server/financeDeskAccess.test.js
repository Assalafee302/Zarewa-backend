import { describe, expect, it } from 'vitest';
import {
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
});
