import { describe, expect, it } from 'vitest';
import {
  conversionSignoffNeedsSecondApprovalClient,
  editMutationNeedsSecondApprovalRole,
} from './editApprovalUi.js';

describe('editApprovalUi conversion signoff', () => {
  it('does not require a KPI code for branch manager or other roles', () => {
    expect(editMutationNeedsSecondApprovalRole('sales_manager')).toBe(true);
    expect(conversionSignoffNeedsSecondApprovalClient('sales_manager')).toBe(false);
    expect(conversionSignoffNeedsSecondApprovalClient('branch_manager')).toBe(false);
    expect(conversionSignoffNeedsSecondApprovalClient('admin')).toBe(false);
  });
});
