import { describe, it, expect } from 'vitest';
import {
  assertSingleBranchWorkspaceForBulkWrite,
  assertTreasuryAccountsBulkForWorkspace,
} from './branchScope.js';

describe('branchScope bulk helpers', () => {
  it('assertSingleBranchWorkspaceForBulkWrite blocks all-branches view', () => {
    const gate = assertSingleBranchWorkspaceForBulkWrite({
      workspaceViewAll: true,
      workspaceBranchId: 'BR-KD',
    });
    expect(gate.ok).toBe(false);
  });

  it('assertTreasuryAccountsBulkForWorkspace allows matching branch accounts', () => {
    const gate = assertTreasuryAccountsBulkForWorkspace(
      { roleKey: 'finance_manager', permissions: ['treasury.manage'] },
      [{ id: 1, name: 'Main', branchId: 'BR-KD' }],
      'BR-KD'
    );
    expect(gate.ok).toBe(true);
  });

  it('assertTreasuryAccountsBulkForWorkspace rejects foreign branch for non-admin', () => {
    const gate = assertTreasuryAccountsBulkForWorkspace(
      { roleKey: 'finance_manager', permissions: ['treasury.manage'] },
      [{ id: 2, name: 'Yola till', branchId: 'BR-YL' }],
      'BR-KD'
    );
    expect(gate.ok).toBe(false);
    expect(String(gate.error || '')).toMatch(/BR-YL/);
  });

  it('assertTreasuryAccountsBulkForWorkspace allows admin any branch', () => {
    const gate = assertTreasuryAccountsBulkForWorkspace(
      { roleKey: 'admin', permissions: ['*'] },
      [{ id: 2, name: 'Yola till', branchId: 'BR-YL' }],
      'BR-KD'
    );
    expect(gate.ok).toBe(true);
  });
});
