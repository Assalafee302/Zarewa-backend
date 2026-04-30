import { describe, it, expect } from 'vitest';
import {
  REFUND_MD_APPROVAL_THRESHOLD_NGN,
  EXPENSE_MD_APPROVAL_THRESHOLD_NGN,
  actorMayApproveRefundAmount,
  actorMayApprovePaymentRequestAmount,
  isRefundLikeExpenseCategory,
  isExecutiveRoleKey,
  isBranchExpenseApproverRoleKey,
} from './workspaceGovernance.js';

describe('workspaceGovernance', () => {
  it('flags executive roles', () => {
    expect(isExecutiveRoleKey('md')).toBe(true);
    expect(isExecutiveRoleKey('CEO')).toBe(true);
    expect(isExecutiveRoleKey('sales_manager')).toBe(false);
  });

  it('detects branch expense approver roles', () => {
    expect(isBranchExpenseApproverRoleKey('sales_manager')).toBe(true);
    expect(isBranchExpenseApproverRoleKey('branch_manager')).toBe(true);
    expect(isBranchExpenseApproverRoleKey('finance_manager')).toBe(false);
  });

  it('detects refund-like expense categories', () => {
    expect(isRefundLikeExpenseCategory('Customer Refund')).toBe(true);
    expect(isRefundLikeExpenseCategory('refund_payout')).toBe(true);
    expect(isRefundLikeExpenseCategory('stationery')).toBe(false);
  });

  it('requires executive (or wildcard) for large refund approvals', () => {
    const has = () => false;
    const hi = REFUND_MD_APPROVAL_THRESHOLD_NGN;
    expect(actorMayApproveRefundAmount({ roleKey: 'sales_manager' }, has, hi + 1)).toBe(false);
    expect(actorMayApproveRefundAmount({ roleKey: 'md' }, has, hi + 1)).toBe(true);
    expect(actorMayApproveRefundAmount({ roleKey: 'finance_manager' }, (p) => p === '*', hi + 1)).toBe(true);
    expect(actorMayApproveRefundAmount({ roleKey: 'finance_manager' }, has, hi)).toBe(true);
  });

  it('respects injected refund threshold', () => {
    const has = () => false;
    expect(actorMayApproveRefundAmount({ roleKey: 'sales_manager' }, has, 50_001, { refundExecutiveThresholdNgn: 50_000 })).toBe(
      false
    );
    expect(actorMayApproveRefundAmount({ roleKey: 'md' }, has, 50_001, { refundExecutiveThresholdNgn: 50_000 })).toBe(true);
  });

  it('requires branch manager or executive for routine expenses under threshold', () => {
    const hasFinance = (p) => p === 'finance.approve';
    const hi = EXPENSE_MD_APPROVAL_THRESHOLD_NGN;
    expect(actorMayApprovePaymentRequestAmount({ roleKey: 'finance_manager' }, hasFinance, hi, 'fuel')).toBe(false);
    expect(actorMayApprovePaymentRequestAmount({ roleKey: 'sales_manager' }, hasFinance, hi, 'fuel')).toBe(true);
    expect(actorMayApprovePaymentRequestAmount({ roleKey: 'md' }, hasFinance, hi, 'fuel')).toBe(true);
    expect(actorMayApprovePaymentRequestAmount({ roleKey: 'sales_manager' }, () => false, hi, 'fuel')).toBe(false);
  });

  it('requires executive above expense threshold', () => {
    const hasFinance = (p) => p === 'finance.approve';
    const hi = EXPENSE_MD_APPROVAL_THRESHOLD_NGN;
    expect(actorMayApprovePaymentRequestAmount({ roleKey: 'sales_manager' }, hasFinance, hi + 1, 'fuel')).toBe(false);
    expect(actorMayApprovePaymentRequestAmount({ roleKey: 'md' }, hasFinance, hi + 1, 'fuel')).toBe(true);
  });

  it('skips expense threshold for refund-like payment categories', () => {
    const hasFinance = (p) => p === 'finance.approve';
    const hi = EXPENSE_MD_APPROVAL_THRESHOLD_NGN;
    expect(actorMayApprovePaymentRequestAmount({ roleKey: 'finance_manager' }, hasFinance, hi + 1, 'customer_refund')).toBe(
      true
    );
  });
});
