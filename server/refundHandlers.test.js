import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  assertCashierMayNotApproveRefund,
  assertRefundApproverNotRequester,
  assertRefundPayerNotApprover,
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
    expect(actorMayOverrideRefundUnclearedPayoutHold({ roleKey: 'md' }, () => false)).toBe(false);
    expect(actorMayOverrideRefundUnclearedPayoutHold({ roleKey: 'finance_manager' }, (p) => p === '*')).toBe(true);
    expect(actorMayOverrideRefundUnclearedPayoutHold({ permissions: ['*'] }, () => false)).toBe(true);
  });

  it('lets admin till-pay only the held slice while other payees sit on partner wallet', () => {
    expect(
      refundTillPayableNgn({
        cashOutstandingNgn: 86_440,
        heldNetNgn: 11_440,
        adminMayPayUncleared: true,
        openWalletNgn: 75_000,
      })
    ).toBe(11_440);
    expect(
      refundTillPayableNgn({
        cashOutstandingNgn: 86_440,
        heldNetNgn: 11_440,
        adminMayPayUncleared: false,
        openWalletNgn: 75_000,
      })
    ).toBe(0);
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
});
