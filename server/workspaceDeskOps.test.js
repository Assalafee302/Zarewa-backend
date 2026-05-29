import { describe, it, expect } from 'vitest';
import { assertSingleBranchWorkspaceForCreate } from './branchScope.js';

describe('workspaceDeskOps harness', () => {
  it('blocks office record create when HQ all-branches roll-up is on', () => {
    const blocked = assertSingleBranchWorkspaceForCreate({
      workspaceViewAll: true,
      workspaceBranchId: 'kaduna',
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.error).toMatch(/all branches/i);
  });

  it('allows create when a single branch workspace is selected', () => {
    const ok = assertSingleBranchWorkspaceForCreate({
      workspaceViewAll: false,
      workspaceBranchId: 'kaduna',
    });
    expect(ok.ok).toBe(true);
  });
});
