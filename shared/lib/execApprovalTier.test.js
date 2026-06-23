import { describe, expect, it } from 'vitest';
import {
  annotateExecWorkTrayApprovalTiers,
  classifyExecWorkTrayApprovalTier,
  EXEC_APPROVAL_TIER_MD_ONLY,
  EXEC_APPROVAL_TIER_SHARED,
  sortExecWorkTrayByApprovalTier,
  summarizeExecWorkTrayApprovalTiers,
} from './execApprovalTier.js';

describe('execApprovalTier', () => {
  const limits = { refundExecutiveThresholdNgn: 1_000_000, expenseExecutiveThresholdNgn: 200_000 };

  it('marks canonical MD-only kinds', () => {
    expect(classifyExecWorkTrayApprovalTier({ kind: 'price_exception' }).tier).toBe(
      EXEC_APPROVAL_TIER_MD_ONLY
    );
    expect(classifyExecWorkTrayApprovalTier({ kind: 'payroll' }).tier).toBe(EXEC_APPROVAL_TIER_MD_ONLY);
    expect(classifyExecWorkTrayApprovalTier({ kind: 'staff_purchase_credit' }).tier).toBe(
      EXEC_APPROVAL_TIER_MD_ONLY
    );
  });

  it('splits refunds by threshold', () => {
    expect(
      classifyExecWorkTrayApprovalTier({ kind: 'refunds', amountNgn: 500_000 }, limits).tier
    ).toBe(EXEC_APPROVAL_TIER_SHARED);
    expect(
      classifyExecWorkTrayApprovalTier({ kind: 'refunds', amountNgn: 1_500_000 }, limits).tier
    ).toBe(EXEC_APPROVAL_TIER_MD_ONLY);
  });

  it('requires MD for zero-payment production gate', () => {
    expect(
      classifyExecWorkTrayApprovalTier({
        kind: 'production',
        reviewContext: { row: { paid_ngn: 0 } },
      }).tier
    ).toBe(EXEC_APPROVAL_TIER_MD_ONLY);
    expect(
      classifyExecWorkTrayApprovalTier({
        kind: 'production',
        reviewContext: { row: { paid_ngn: 50_000 } },
      }).tier
    ).toBe(EXEC_APPROVAL_TIER_SHARED);
  });

  it('annotates and sorts MD-only ahead of shared', () => {
    const rows = annotateExecWorkTrayApprovalTiers(
      [
        { id: 'a', kind: 'clearance', priority: 'high' },
        { id: 'b', kind: 'price_exception', priority: 'medium' },
      ],
      limits
    );
    const sorted = sortExecWorkTrayByApprovalTier(rows);
    expect(sorted[0].id).toBe('b');
    expect(summarizeExecWorkTrayApprovalTiers(rows)).toEqual({ mdOnly: 1, shared: 1, total: 2 });
  });
});
