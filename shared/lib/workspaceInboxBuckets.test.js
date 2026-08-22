import { describe, it, expect } from 'vitest';
import {
  workItemNeedsActionForUser,
  workItemIsFiledTrayItem,
  workItemShowsInFileTray,
  workItemShowsInUnfiledTray,
  fileTrayCategoryLabel,
  groupFileTrayItemsByCategory,
} from './workspaceInboxBuckets.js';

describe('workspaceInboxBuckets', () => {
  it('needsAction respects assignee', () => {
    expect(
      workItemNeedsActionForUser(
        { requiresApproval: true, responsibleUserId: 'a' },
        'a'
      )
    ).toBe(true);
    expect(
      workItemNeedsActionForUser(
        { requiresApproval: true, responsibleUserId: 'a' },
        'b'
      )
    ).toBe(false);
    expect(workItemNeedsActionForUser({ requiresApproval: false, requiresResponse: false }, 'a')).toBe(false);
  });

  it('filed tray detects closed or cleared flags', () => {
    expect(workItemIsFiledTrayItem({ requiresApproval: false, requiresResponse: false })).toBe(true);
    expect(workItemIsFiledTrayItem({ status: 'closed', requiresApproval: true })).toBe(true);
    expect(workItemIsFiledTrayItem({ requiresApproval: true })).toBe(false);
  });

  it('treats closed quotation clearance as not needing action', () => {
    expect(
      workItemNeedsActionForUser(
        { documentType: 'quotation_clearance', status: 'closed', requiresApproval: false, requiresResponse: false },
        'u1'
      )
    ).toBe(false);
    expect(
      workItemNeedsActionForUser(
        { documentType: 'quotation_clearance', status: 'pending_review', requiresApproval: true },
        'u1'
      )
    ).toBe(true);
  });

  it('groups file tray by category', () => {
    const a = { documentType: 'memo', sourceKind: 'office_thread', requiresApproval: false, requiresResponse: false, senderUserId: 'u1' };
    const b = { documentType: 'hr_leave', requiresApproval: false, requiresResponse: false, senderUserId: 'u1' };
    expect(groupFileTrayItemsByCategory([a, b]).map((g) => g.category)).toContain('Correspondence & memos');
    expect(fileTrayCategoryLabel(b)).toBe('Internal');
  });

  it('file tray hides non-personal manager-queue stubs', () => {
    const ctx = { userId: 'u1', roleKey: 'sales_manager', permissions: [] };
    const filedMemo = {
      documentType: 'memo',
      senderUserId: 'u1',
      requiresApproval: false,
      requiresResponse: false,
    };
    expect(workItemShowsInFileTray(filedMemo, ctx)).toBe(true);

    const filedClearance = {
      documentType: 'quotation_clearance',
      requiresApproval: false,
      requiresResponse: false,
    };
    expect(workItemShowsInFileTray(filedClearance, ctx)).toBe(false);
  });

  it('unfiled tray lists filed items with incomplete filing metadata', () => {
    const ctx = { userId: 'u1', roleKey: 'finance_manager', permissions: ['finance.approve'] };
    const item = {
      documentType: 'payment_request',
      senderUserId: 'u1',
      requiresApproval: false,
      requiresResponse: false,
      filingIncomplete: true,
    };
    expect(workItemShowsInUnfiledTray(item, ctx)).toBe(true);
    expect(workItemShowsInUnfiledTray({ ...item, filingIncomplete: false }, ctx)).toBe(false);
  });
});
