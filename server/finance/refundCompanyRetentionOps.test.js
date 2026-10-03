/**
 * Company retention withdrawal cancel + BM cash-approve gates (pure / lightweight).
 */
import { describe, it, expect } from 'vitest';
import { actorMayCashApproveCompanyRetentionWithdrawal } from './refundCompanyRetentionOps.js';
import { companyRetentionAvailability } from './refundCompanyRetentionLedger.js';

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

  it('locks an open withdrawal until it is paid or cancelled', () => {
    expect(
      companyRetentionAvailability({ totalOpenNgn: 961_510, reservedNgn: 50_000, cooldownActive: false })
    ).toMatchObject({ availableNgn: 911_510, heldNgn: 50_000, reservedNgn: 50_000 });
    expect(
      companyRetentionAvailability({ totalOpenNgn: 911_510, reservedNgn: 0, cooldownActive: false })
    ).toMatchObject({ availableNgn: 911_510, heldNgn: 0, reservedNgn: 0 });
  });

  it('keeps investigation-linked retention out of available, and freezes the rest', () => {
    expect(
      companyRetentionAvailability({
        totalOpenNgn: 1_000_000,
        reservedNgn: 0,
        excludedNgn: 40_000,
        withdrawalFrozen: false,
      })
    ).toMatchObject({ availableNgn: 960_000, excludedNgn: 40_000, heldNgn: 40_000 });
    expect(
      companyRetentionAvailability({
        totalOpenNgn: 1_000_000,
        excludedNgn: 40_000,
        withdrawalFrozen: true,
      })
    ).toMatchObject({ availableNgn: 0, withdrawalFrozen: true });
  });

  it('locks the whole balance during the post-payout cooldown', () => {
    expect(
      companyRetentionAvailability({ totalOpenNgn: 100_000, reservedNgn: 0, cooldownActive: true })
    ).toMatchObject({ availableNgn: 0, heldNgn: 100_000 });
  });

  it('blocks cashier and finance_manager without BM role', () => {
    expect(actorMayCashApproveCompanyRetentionWithdrawal({ roleKey: 'cashier' })).toBe(false);
    expect(actorMayCashApproveCompanyRetentionWithdrawal({ roleKey: 'finance_manager' })).toBe(
      false
    );
    expect(actorMayCashApproveCompanyRetentionWithdrawal({ roleKey: 'sales_staff' })).toBe(false);
  });
});
