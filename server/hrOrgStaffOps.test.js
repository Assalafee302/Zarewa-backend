import { describe, expect, it } from 'vitest';
import { permissionsForRole } from './auth.js';
import {
  backfillLegacyPayAdditions,
  buildSupplementalPermissionsForRoles,
  findStaffCoveringOffice,
  recommendAppRoleKeys,
  validateStaffOrgRoles,
} from './hrOrgStaffOps.js';

describe('hrOrgStaffOps', () => {
  it('recommendAppRoleKeys maps designation to app role', () => {
    const hints = recommendAppRoleKeys({
      designationId: 'desig_hoa',
      secondaryRoles: [{ designationId: 'desig_actbm', officeKey: 'branch_manager', branchId: 'BR-KD' }],
      currentRoleKey: 'cashier',
    });
    expect(hints.recommendedPrimary).toBe('finance_manager');
    expect(hints.suggestedRoleKeys).toContain('finance_manager');
    expect(hints.suggestedRoleKeys).toContain('sales_manager');
    expect(hints.needsReview).toBe(true);
    expect(Array.isArray(hints.supplementalPermissions)).toBe(true);
  });

  it('buildSupplementalPermissionsForRoles excludes primary role permissions', () => {
    const primary = new Set(permissionsForRole('finance_manager'));
    const extra = buildSupplementalPermissionsForRoles(['finance_manager', 'sales_manager'], 'finance_manager');
    for (const p of extra) {
      expect(primary.has(p)).toBe(false);
    }
  });

  it('validateStaffOrgRoles requires acting end date', () => {
    const r = validateStaffOrgRoles({
      designationId: 'desig_hoa',
      branchId: 'BR-KD',
      secondaryRoles: [{ role: 'Acting BM', officeKey: 'branch_manager', branchId: 'BR-KD', acting: true }],
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/end date/i);
  });

  it('findStaffCoveringOffice matches secondary desk', () => {
    const db = {
      prepare: () => ({
        all: () => [
          {
            userId: 'U-1',
            displayName: 'Jane',
            branchId: 'BR-KD',
            jobTitle: 'Head Accountant',
            designationId: 'desig_hoa',
            profileExtraJson: JSON.stringify({
              employmentMeta: {
                secondaryRoles: [
                  {
                    role: 'Acting Branch Manager',
                    officeKey: 'branch_manager',
                    branchId: 'BR-KD',
                    acting: true,
                    endDateIso: '2026-12-31',
                  },
                ],
              },
            }),
          },
        ],
      }),
    };
    const matches = findStaffCoveringOffice(db, { officeKey: 'branch_manager', branchId: 'BR-KD' });
    expect(matches.length).toBe(1);
    expect(matches[0].userId).toBe('U-1');
  });

  it('backfillLegacyPayAdditions splits legacy pay into addition', () => {
    const updates = [];
    const matrixRow = {
      baseSalaryNgn: 450_000,
      housingAllowanceNgn: 60_000,
      transportAllowanceNgn: 30_000,
    };
    const db = {
      prepare: (sql) => {
        const s = String(sql);
        if (s.includes('sqlite_master')) {
          return { get: () => ({ 1: 1 }) };
        }
        if (s.includes('hr_salary_matrix')) {
          return { get: () => matrixRow };
        }
        if (s.includes('FROM hr_staff_profiles')) {
          return {
            all: () => [
              {
                userId: 'U-2',
                displayName: 'Bob',
                branchId: 'BR-KD',
                payrollGroup: 'branch_ops',
                salaryLevel: 5,
                salaryStep: 1,
                baseSalaryNgn: 750_000,
                housingAllowanceNgn: 60_000,
                transportAllowanceNgn: 30_000,
                profileExtraJson: '{}',
              },
            ],
          };
        }
        if (s.includes('UPDATE hr_staff_profiles')) {
          return { run: (...args) => updates.push(args) };
        }
        return { all: () => [], get: () => null, run: () => {} };
      },
    };
    const r = backfillLegacyPayAdditions(db, { viewAll: true }, { dryRun: false });
    expect(r.updatedCount).toBe(1);
    expect(r.updated[0].payAdditionNgn).toBe(300_000);
    expect(updates.length).toBe(1);
  });
});
