import { describe, expect, it } from 'vitest';
import {
  explainApprovalBlock,
  userCanApproveWorkItem,
  approvalBlockContextForWorkItem,
} from './zareApprovalHints.js';

describe('zareApprovalHints', () => {
  it('detects finance payment request permission', () => {
    const item = { requiresApproval: true, documentType: 'payment_request' };
    expect(userCanApproveWorkItem(item, { permissions: ['finance.approve'] })).toBe(true);
    expect(userCanApproveWorkItem(item, { roleKey: 'sales_manager', permissions: [] })).toBe(true);
    expect(userCanApproveWorkItem(item, { permissions: ['sales.view'] })).toBe(false);
  });

  it('explains missing permission', () => {
    const ex = explainApprovalBlock({
      canApprove: false,
      documentType: 'payment_request',
      referenceNo: 'PR-1',
    });
    expect(ex.show).toBe(true);
    expect(ex.reasons.some((r) => /finance/i.test(r))).toBe(true);
  });

  it('builds work item context with branch mismatch', () => {
    const ctx = approvalBlockContextForWorkItem(
      { requiresApproval: true, documentType: 'refund_request', referenceNo: 'RF-1', branchId: 'b2' },
      { permissions: [], branchId: 'b1', viewAllBranches: false, branchNames: { b2: 'Abuja' } }
    );
    expect(ctx.branchMismatch).toBe(true);
    expect(ctx.canApprove).toBe(false);
  });
});
