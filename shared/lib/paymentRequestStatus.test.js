import { describe, expect, it } from 'vitest';
import {
  canonicalPaymentRequestApprovalStatus,
  isPaymentRequestApprovedForPayout,
  isPaymentRequestEditable,
  isPaymentRequestOpenForReview,
  paymentRequestCashStage,
  paymentRequestLifecycleStatus,
  paymentRequestOpenApprovalSql,
  paymentRequestStatusApiFields,
} from './paymentRequestStatus.js';

describe('paymentRequestStatus', () => {
  it('canonicalizes legacy open aliases to Pending and stored Paid to Approved', () => {
    expect(canonicalPaymentRequestApprovalStatus('')).toBe('Pending');
    expect(canonicalPaymentRequestApprovalStatus('Submitted')).toBe('Pending');
    expect(canonicalPaymentRequestApprovalStatus('Awaiting approval')).toBe('Pending');
    expect(canonicalPaymentRequestApprovalStatus('Paid')).toBe('Approved');
    expect(canonicalPaymentRequestApprovalStatus('Rejected')).toBe('Rejected');
  });

  it('treats aliases as open for review and Rejected as editable', () => {
    expect(isPaymentRequestOpenForReview('Submitted')).toBe(true);
    expect(isPaymentRequestOpenForReview('Approved')).toBe(false);
    expect(isPaymentRequestEditable('Rejected')).toBe(true);
    expect(isPaymentRequestEditable('Approved')).toBe(false);
    expect(isPaymentRequestApprovedForPayout('Paid')).toBe(true);
    expect(isPaymentRequestApprovedForPayout('Pending')).toBe(false);
  });

  it('derives Partially paid and Paid from amounts without persisting them', () => {
    expect(
      paymentRequestLifecycleStatus({
        approvalStatus: 'Approved',
        amountRequestedNgn: 10_000,
        paidAmountNgn: 0,
      })
    ).toBe('Approved');
    expect(
      paymentRequestLifecycleStatus({
        approvalStatus: 'Approved',
        amountRequestedNgn: 10_000,
        paidAmountNgn: 4_000,
      })
    ).toBe('Partially paid');
    expect(
      paymentRequestLifecycleStatus({
        approvalStatus: 'Approved',
        amountRequestedNgn: 10_000,
        paidAmountNgn: 10_000,
      })
    ).toBe('Paid');
    expect(
      paymentRequestLifecycleStatus({
        approvalStatus: 'Paid',
        amountRequestedNgn: 10_000,
        paidAmountNgn: 10_000,
      })
    ).toBe('Paid');
  });

  it('maps cash stages for exception totals', () => {
    expect(paymentRequestCashStage({ approvalStatus: 'Pending', amountRequestedNgn: 5 })).toBe(
      'pending'
    );
    expect(
      paymentRequestCashStage({
        approvalStatus: 'Approved',
        amountRequestedNgn: 5,
        paidAmountNgn: 0,
      })
    ).toBe('approved_unpaid');
    expect(
      paymentRequestCashStage({
        approvalStatus: 'Approved',
        amountRequestedNgn: 5,
        paidAmountNgn: 5,
      })
    ).toBe('paid');
    expect(paymentRequestCashStage({ approvalStatus: 'Rejected' })).toBe('other');
  });

  it('exposes API fields from snake_case rows', () => {
    expect(
      paymentRequestStatusApiFields({
        approval_status: 'Submitted',
        amount_requested_ngn: 100,
        paid_amount_ngn: 0,
      })
    ).toEqual({ approvalStatus: 'Pending', lifecycleStatus: 'Pending' });
  });

  it('builds an open-approval SQL predicate', () => {
    expect(paymentRequestOpenApprovalSql('pr.approval_status')).toContain('pr.approval_status');
    expect(paymentRequestOpenApprovalSql()).toContain("'Pending'");
  });
});
