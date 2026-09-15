import { describe, it, expect } from 'vitest';
import {
  approvalAttentionPathForRole,
  approvalDeskHomeForRole,
  roleUsesExecutiveApprovalDesk,
} from './approvalDeskPaths.js';

describe('approvalDeskPaths', () => {
  it('routes MD/CEO/Chairman to exec decide', () => {
    expect(roleUsesExecutiveApprovalDesk('md')).toBe(true);
    expect(approvalDeskHomeForRole('md')).toBe('/exec?tab=decide');
    expect(approvalAttentionPathForRole('ceo', 'cash_out')).toBe('/exec?tab=decide');
  });

  it('routes branch managers to manager inboxes', () => {
    expect(roleUsesExecutiveApprovalDesk('sales_manager')).toBe(false);
    expect(approvalDeskHomeForRole('sales_manager')).toBe('/manager');
    expect(approvalAttentionPathForRole('sales_manager', 'cash_out')).toBe(
      '/manager?tab=approvals&inbox=cash_out'
    );
  });
});
