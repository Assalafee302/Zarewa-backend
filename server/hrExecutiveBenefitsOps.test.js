import { describe, expect, it } from 'vitest';
import {
  userCanManageExecutiveBenefits,
  userCanViewExecutiveBenefits,
} from './hrExecutiveBenefitsOps.js';
import {
  hrApiPathAllowedWithoutMainWorkspace,
  userCanViewExecutiveBenefits as permViewExecutive,
} from './hrPermissions.js';

describe('hrExecutiveBenefitsOps permissions', () => {
  const md = { id: 'MD', permissions: ['hr.executive.view', 'hr.executive.benefits.manage'] };
  const branchManager = { id: 'BM', roleKey: 'sales_manager', permissions: ['hr.team.view'] };
  const staff = { id: 'ST', permissions: ['hr.self'] };

  it('MD can view and manage executive benefits', () => {
    expect(userCanViewExecutiveBenefits(md)).toBe(true);
    expect(userCanManageExecutiveBenefits(md)).toBe(true);
  });

  it('branch manager and staff cannot access executive benefits', () => {
    expect(userCanViewExecutiveBenefits(branchManager)).toBe(false);
    expect(userCanManageExecutiveBenefits(branchManager)).toBe(false);
    expect(userCanViewExecutiveBenefits(staff)).toBe(false);
  });

  it('executive API paths allowed without main HR workspace', () => {
    expect(hrApiPathAllowedWithoutMainWorkspace('/api/hr/executive/dashboard', { selfUser: true })).toBe(true);
    expect(hrApiPathAllowedWithoutMainWorkspace('/api/hr/executive/family-dashboard', { selfUser: true })).toBe(true);
    expect(hrApiPathAllowedWithoutMainWorkspace('/api/hr/executive/domestic-dashboard', { selfUser: true })).toBe(true);
    expect(hrApiPathAllowedWithoutMainWorkspace('/api/hr/executive/beneficiaries', { teamUser: true })).toBe(true);
    expect(permViewExecutive(md)).toBe(true);
    expect(permViewExecutive(branchManager)).toBe(false);
  });
});
