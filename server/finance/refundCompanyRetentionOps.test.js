/**
 * Company retention withdrawal cancel + BM cash-approve gates (pure / lightweight).
 */
import { describe, it, expect } from 'vitest';
import { actorMayCashApproveCompanyRetentionWithdrawal } from './refundCompanyRetentionOps.js';

describe('actorMayCashApproveCompanyRetentionWithdrawal', () => {
  it('allows Branch Manager role keys', () => {
    expect(actorMayCashApproveCompanyRetentionWithdrawal({ roleKey: 'sales_manager' })).toBe(true);
    expect(actorMayCashApproveCompanyRetentionWithdrawal({ roleKey: 'branch_manager' })).toBe(true);
  });

  it('allows admin / wildcard', () => {
    expect(actorMayCashApproveCompanyRetentionWithdrawal({ roleKey: 'admin' })).toBe(true);
    expect(
      actorMayCashApproveCompanyRetentionWithdrawal({ roleKey: 'cashier', permissions: ['*'] })
    ).toBe(true);
  });

  it('blocks cashier and finance_manager without BM role', () => {
    expect(actorMayCashApproveCompanyRetentionWithdrawal({ roleKey: 'cashier' })).toBe(false);
    expect(actorMayCashApproveCompanyRetentionWithdrawal({ roleKey: 'finance_manager' })).toBe(
      false
    );
    expect(actorMayCashApproveCompanyRetentionWithdrawal({ roleKey: 'sales_staff' })).toBe(false);
  });
});
