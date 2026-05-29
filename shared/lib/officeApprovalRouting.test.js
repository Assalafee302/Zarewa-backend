import { describe, it, expect } from 'vitest';
import { computeOfficeApprovalRoute, branchManagerCanApproveAmount } from './officeApprovalRouting.js';
import { EXPENSE_MD_APPROVAL_THRESHOLD_NGN } from '../workspaceGovernance.js';

describe('officeApprovalRouting', () => {
  it('requires MD above threshold', () => {
    const r = computeOfficeApprovalRoute({
      expenseCategory: 'maintenance',
      amountNgn: EXPENSE_MD_APPROVAL_THRESHOLD_NGN + 1,
      requesterRoleKey: 'sales_staff',
    });
    expect(r.requiresMd).toBe(true);
    expect(r.steps.some((s) => s.role === 'md')).toBe(true);
  });

  it('branch manager can approve below threshold', () => {
    expect(branchManagerCanApproveAmount('sales_manager', 150_000)).toBe(true);
    expect(branchManagerCanApproveAmount('sales_manager', 250_000)).toBe(false);
  });

  it('fuel route includes cashier', () => {
    const r = computeOfficeApprovalRoute({ expenseCategory: 'fuel_diesel', amountNgn: 50_000 });
    expect(r.steps.some((s) => s.role === 'cashier')).toBe(true);
  });
});
