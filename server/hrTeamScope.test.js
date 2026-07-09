import { describe, expect, it } from 'vitest';
import { isBranchManagerHrScopeRole, resolveHrScopeMode } from './hrTeamScope.js';

describe('resolveHrScopeMode', () => {
  const branchManager = { roleKey: 'sales_manager', permissions: ['hr.team.view'] };
  const supervisor = { roleKey: 'sales_staff', permissions: ['hr.team.view'] };

  it('uses branch scope for branch managers on team HR (all branch staff)', () => {
    expect(isBranchManagerHrScopeRole('sales_manager')).toBe(true);
    expect(resolveHrScopeMode(branchManager)).toBe('branch');
    expect(resolveHrScopeMode(branchManager, 'team')).toBe('branch');
  });

  it('keeps team scope for non-branch-manager supervisors', () => {
    expect(resolveHrScopeMode(supervisor)).toBe('team');
    expect(resolveHrScopeMode(supervisor, 'team')).toBe('team');
  });
});
