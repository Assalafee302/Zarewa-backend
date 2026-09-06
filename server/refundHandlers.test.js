import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  assertCashierMayNotApproveRefund,
  assertRefundApproverNotRequester,
  assertRefundPayerNotApprover,
  assertActorMayPayCustomerRefund,
  actorMayOverrideRefundUnclearedPayoutHold,
  isRefundAdminTrialActor,
  refundTillPayableNgn,
} from './refundHandlers.js';

describe('refundHandlers (Phase 11A)', () => {
  const savedEnv = {};

  beforeEach(() => {
    savedEnv.ENFORCE_DUAL_CONTROL_PAYMENTS = process.env.ENFORCE_DUAL_CONTROL_PAYMENTS;
  });

  afterEach(() => {
    if (savedEnv.ENFORCE_DUAL_CONTROL_PAYMENTS === undefined) {
      delete process.env.ENFORCE_DUAL_CONTROL_PAYMENTS;
    } else {
      process.env.ENFORCE_DUAL_CONTROL_PAYMENTS = savedEnv.ENFORCE_DUAL_CONTROL_PAYMENTS;
    }
  });

  it('detects admin trial actor', () => {
    expect(isRefundAdminTrialActor({ roleKey: 'admin' }, () => false)).toBe(true);
    expect(isRefundAdminTrialActor({ roleKey: 'sales_manager' }, (p) => p === '*')).toBe(true);
    expect(isRefundAdminTrialActor({ roleKey: 'md' }, () => false)).toBe(false);
  });

  it('lets admin override uncleared-receipt payout hold, not cashier or MD', () => {
    expect(actorMayOverrideRefundUnclearedPayoutHold({ roleKey: 'admin' }, () => false)).toBe(true);
    expect(actorMayOverrideRefundUnclearedPayoutHold({ roleKey: 'cashier' }, () => false)).toBe(false);
    expect(actorMayOverrideRefundUnclearedPayoutHold({ roleKey: 'cashier' }, (p) => p === 'finance.approve')).toBe(
      false
    );
    expect(actorMayOverrideRefundUnclearedPayoutHold({ roleKey: 'md' }, () => false)).toBe(false);
    expect(actorMayOverrideRefundUnclearedPayoutHold({ roleKey: 'finance_manager' }, () => false)).toBe(true);
    expect(actorMayOverrideRefundUnclearedPayoutHold({ roleKey: 'sales_manager' }, () => false)).toBe(true);
    expect(
      actorMayOverrideRefundUnclearedPayoutHold({ roleKey: 'finance_manager' }, (p) => p === '*')
    ).toBe(true);
    expect(actorMayOverrideRefundUnclearedPayoutHold({ permissions: ['*'] }, () => false)).toBe(true);
    expect(
      actorMayOverrideRefundUnclearedPayoutHold({ roleKey: 'viewer' }, (p) => p === 'refunds.approve')
    ).toBe(true);
  });

  it('lets cashier till-pay non-wallet surplus while partner wallet stays open', () => {
    // cash 86,440 = wallet 75,000 + held 11,440 → cashier till = 0
    expect(
      refundTillPayableNgn({
        cashOutstandingNgn: 86_440,
        heldNetNgn: 11_440,
        adminMayPayUncleared: false,
        openWalletNgn: 75_000,
      })
    ).toBe(0);
    // Admin exception: till = cash − wallet (held slice allowed)
    expect(
      refundTillPayableNgn({
        cashOutstandingNgn: 86_440,
        heldNetNgn: 11_440,
        adminMayPayUncleared: true,
        openWalletNgn: 75_000,
      })
    ).toBe(11_440);
    // Wallet 40k + customer till 20k + held 10k → cashier can pay the 20k till surplus
    expect(
      refundTillPayableNgn({
        cashOutstandingNgn: 70_000,
        heldNetNgn: 10_000,
        adminMayPayUncleared: false,
        openWalletNgn: 40_000,
      })
    ).toBe(20_000);
    expect(
      refundTillPayableNgn({
        cashOutstandingNgn: 48_960,
        heldNetNgn: 48_960,
        adminMayPayUncleared: true,
        openWalletNgn: 0,
      })
    ).toBe(48_960);
    expect(
      refundTillPayableNgn({
        cashOutstandingNgn: 48_960,
        heldNetNgn: 48_960,
        adminMayPayUncleared: false,
        openWalletNgn: 0,
      })
    ).toBe(0);
  });

  it('blocks requester from approving own refund', () => {
    const row = { requested_by_user_id: 'USR-1', requested_by: 'Alice' };
    const actor = { id: 'USR-1', displayName: 'Alice', roleKey: 'sales_manager' };
    const has = (p) => p === 'refunds.approve';
    const r = assertRefundApproverNotRequester(row, actor, has);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cannot approve a refund you requested/i);
  });

  it('allows admin to approve own refund (trial)', () => {
    const row = { requested_by_user_id: 'USR-ADMIN', requested_by: 'Zarewa Admin' };
    const actor = { id: 'USR-ADMIN', displayName: 'Zarewa Admin', roleKey: 'admin' };
    const r = assertRefundApproverNotRequester(row, actor, (p) => p === '*');
    expect(r.ok).toBe(true);
    expect(r.adminTrial).toBe(true);
  });

  it('blocks cashier from refund approval decision', () => {
    const has = (p) => p === 'finance.approve';
    const r = assertCashierMayNotApproveRefund({ roleKey: 'cashier' }, has);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cashiers may only pay/i);
  });

  it('blocks approver from paying when dual-control flag is on', () => {
    process.env.ENFORCE_DUAL_CONTROL_PAYMENTS = '1';
    const row = {
      approved_by_user_id: 'USR-FIN',
      approved_by: 'Finance Manager',
    };
    const actor = { id: 'USR-FIN', displayName: 'Finance Manager', roleKey: 'finance_manager' };
    const r = assertRefundPayerNotApprover(row, actor, () => false);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/cannot pay out a refund you approved/i);
  });

  it('allows different payer when dual-control flag is on', () => {
    process.env.ENFORCE_DUAL_CONTROL_PAYMENTS = '1';
    const row = {
      approved_by_user_id: 'USR-SM',
      approved_by: 'Sales Manager',
    };
    const actor = { id: 'USR-FIN', displayName: 'Finance Manager', roleKey: 'finance_manager' };
    const r = assertRefundPayerNotApprover(row, actor, () => false);
    expect(r.ok).toBe(true);
  });

  it('does not block approver=payer when dual-control flag is off', () => {
    process.env.ENFORCE_DUAL_CONTROL_PAYMENTS = '0';
    const row = { approved_by_user_id: 'USR-FIN', approved_by: 'Finance Manager' };
    const actor = { id: 'USR-FIN', displayName: 'Finance Manager', roleKey: 'finance_manager' };
    const r = assertRefundPayerNotApprover(row, actor, () => false);
    expect(r.ok).toBe(true);
  });

  it('blocks MD from customer-refund payout while leaving dual-control for other roles', () => {
    process.env.ENFORCE_DUAL_CONTROL_PAYMENTS = '0';
    const row = { approved_by_user_id: 'USR-SM', approved_by: 'Sales Manager' };
    const md = { id: 'USR-MD', displayName: 'Managing Director', roleKey: 'md' };
    const blocked = assertActorMayPayCustomerRefund(row, md, () => false);
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toMatch(/cannot pay customer refunds/i);

    const cashier = { id: 'USR-CASH', displayName: 'Cashier', roleKey: 'cashier' };
    const allowed = assertActorMayPayCustomerRefund(row, cashier, () => false);
    expect(allowed.ok).toBe(true);

    const admin = { id: 'USR-ADMIN', displayName: 'Zarewa Admin', roleKey: 'admin' };
    const trial = assertActorMayPayCustomerRefund(row, admin, (p) => p === '*');
    expect(trial.ok).toBe(true);
    expect(trial.adminTrial).toBe(true);
  });
});
