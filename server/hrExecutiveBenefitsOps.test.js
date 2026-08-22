import { describe, expect, it } from 'vitest';
import {
  isHouseholdPayment,
  summarizePaymentRows,
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

describe('summarizePaymentRows', () => {
  it('treats domestic source as household', () => {
    expect(isHouseholdPayment({ sourceKind: 'domestic_staff' })).toBe(true);
    expect(isHouseholdPayment({ paymentType: 'school_fee' })).toBe(false);
  });

  it('counts paid amounts by paidAtIso, not the billed period', () => {
    const rows = [
      {
        sourceKind: 'domestic_staff',
        amountNgn: 100_000,
        status: 'paid',
        paidAtIso: '2026-08-12',
        periodYyyymm: '2026-07',
      },
      {
        sourceKind: 'school_fee',
        amountNgn: 250_000,
        status: 'paid',
        paidAtIso: '2026-08-03',
        periodYyyymm: '2026-08',
      },
      {
        sourceKind: 'school_fee',
        amountNgn: 80_000,
        status: 'approved',
        periodYyyymm: '2026-08',
      },
    ];
    const august = summarizePaymentRows(rows, { periodYyyymm: '2026-08', yearPrefix: '2026' });
    expect(august.householdPaidMonthNgn).toBe(100_000);
    expect(august.scholarshipPaidMonthNgn).toBe(250_000);
    expect(august.householdPaidYtdNgn).toBe(100_000);
    expect(august.scholarshipPaidYtdNgn).toBe(250_000);
    expect(august.pendingBenefitPaymentsNgn).toBe(80_000);
    expect(august.pendingBenefitPaymentCount).toBe(1);

    const july = summarizePaymentRows(rows, { periodYyyymm: '2026-07', yearPrefix: '2026' });
    expect(july.householdPaidMonthNgn).toBe(0);
    expect(july.scholarshipPaidMonthNgn).toBe(0);
  });
});
