import { describe, expect, it } from 'vitest';
import {
  applyBulkMatrixRevisionToProfiles,
  buildOrgCompensationDashboardAlerts,
  computeCompensationVariance,
  daysUntilIsoDate,
  isDirectorCorporateEligible,
  mergeCompensationProfileExtra,
  resolveStaffCompensationForSave,
  shouldAutoApplyMatrixPay,
  totalCompensationNgn,
} from './hrCompensationOps.js';
import { buildStaffMergedOffices } from './hrOrgConstants.js';
import { PAYROLL_MATRIX_GROUP_SCALES } from './hrOrgSeed.js';

describe('hrCompensationOps', () => {
  const matrixRow = {
    baseSalaryNgn: 450_000,
    housingAllowanceNgn: 60_000,
    transportAllowanceNgn: 30_000,
  };

  it('exports variance type catalog', async () => {
    const { COMPENSATION_VARIANCE_TYPES } = await import('./hrCompensationOps.js');
    expect(COMPENSATION_VARIANCE_TYPES.some((t) => t.value === 'multi_role_consolidation')).toBe(true);
  });

  it('payroll matrix group scales differentiate special groups', () => {
    expect(PAYROLL_MATRIX_GROUP_SCALES.mining_div.scale).toBeGreaterThan(PAYROLL_MATRIX_GROUP_SCALES.branch_ops.scale);
    expect(PAYROLL_MATRIX_GROUP_SCALES.scholarship.scale).toBeLessThan(PAYROLL_MATRIX_GROUP_SCALES.branch_ops.scale);
    expect(PAYROLL_MATRIX_GROUP_SCALES.chairman_staffs.scale).toBeLessThan(PAYROLL_MATRIX_GROUP_SCALES.branch_ops.scale);
  });

  it('computeCompensationVariance detects above-matrix pay', () => {
    const v = computeCompensationVariance(matrixRow, {
      baseSalaryNgn: 900_000,
      housingAllowanceNgn: 60_000,
      transportAllowanceNgn: 30_000,
    });
    expect(v.aboveMatrix).toBe(true);
    expect(v.varianceNgn).toBe(450_000);
  });

  it('shouldAutoApplyMatrixPay on new hire with blank base', () => {
    expect(
      shouldAutoApplyMatrixPay({
        existing: false,
        body: { salaryLevel: 3 },
        prevRow: null,
      })
    ).toBe(true);
  });

  it('mergeCompensationProfileExtra stores documented variance', () => {
    const extra = mergeCompensationProfileExtra(
      {},
      {
        designationId: 'desig_md',
        compensationVarianceType: 'director_emolument',
        compensationVarianceNotes: 'Board letter on file',
        secondaryRoles: [{ designationId: 'desig_actbm', role: 'Acting Branch Manager', branchId: 'BR-KD', acting: true }],
        corporateTitle: 'Director',
        payAdditionNgn: 300_000,
      },
      {
        actorUserId: 'U-MD',
        designationId: 'desig_md',
        varianceCalc: computeCompensationVariance(matrixRow, {
          baseSalaryNgn: 750_000,
          housingAllowanceNgn: 60_000,
          transportAllowanceNgn: 30_000,
        }),
        matrixRow,
      }
    );
    expect(extra.compensationVariance.type).toBe('director_emolument');
    expect(extra.employmentMeta.corporateTitle).toBe('Director');
    expect(extra.employmentMeta.secondaryRoles[0].officeKey).toBe('branch_manager');
    expect(extra.compensation.payAdditionNgn).toBe(300_000);
  });

  it('resolveStaffCompensationForSave applies matrix plus pay addition', () => {
    const db = {
      prepare: (sql) => ({
        get: () => {
          if (String(sql).includes('sqlite_master')) return { 1: 1 };
          return matrixRow;
        },
      }),
    };
    const r = resolveStaffCompensationForSave(db, {
      body: {
        payAdditionNgn: 100_000,
        compensationVarianceType: 'multi_role_consolidation',
        compensationVarianceNotes: 'Acting BM + cashier',
      },
      prevRow: { designation_id: 'desig_hoa' },
      existing: true,
      resolvedSalaryLevel: 5,
      resolvedSalaryStep: 1,
      normalizedPayrollGroup: 'branch_ops',
    });
    expect(r.ok).toBe(true);
    expect(r.baseSalaryNgn).toBe(550_000);
    expect(r.payAdditionNgn).toBe(100_000);
    expect(r.variance.aboveMatrix).toBe(true);
    expect(r.variance.varianceNgn).toBe(100_000);
  });

  it('resolveStaffCompensationForSave blocks undocumented above-matrix pay', () => {
    const db = {
      prepare: (sql) => ({
        get: () => {
          if (String(sql).includes('sqlite_master')) return { 1: 1 };
          return matrixRow;
        },
      }),
    };
    const r = resolveStaffCompensationForSave(db, {
      body: {
        baseSalaryNgn: 900_000,
        housingAllowanceNgn: 60_000,
        transportAllowanceNgn: 30_000,
      },
      prevRow: { base_salary_ngn: 450_000, housing_allowance_ngn: 60_000, transport_allowance_ngn: 30_000 },
      existing: true,
      resolvedSalaryLevel: 5,
      resolvedSalaryStep: 1,
      normalizedPayrollGroup: 'branch_ops',
    });
    expect(r.ok).toBe(false);
    expect(r.code).toBe('compensation_variance_required');
  });

  it('daysUntilIsoDate counts calendar days', () => {
    expect(daysUntilIsoDate('2026-06-20', '2026-06-15')).toBe(5);
    expect(daysUntilIsoDate('2026-06-10', '2026-06-15')).toBe(-5);
  });

  it('applyBulkMatrixRevisionToProfiles updates pay when matrix differs', () => {
    const matrixRow = {
      payrollGroup: 'branch_ops',
      salaryLevel: 5,
      salaryStep: 1,
      baseSalaryNgn: 450_000,
      housingAllowanceNgn: 60_000,
      transportAllowanceNgn: 30_000,
    };
    const db = {
      prepare: (sql) => {
        if (String(sql).includes('sqlite_master')) {
          return { get: () => ({ c: 1 }) };
        }
        if (String(sql).includes('FROM hr_staff_profiles p')) {
          return {
            all: () => [
              {
                userId: 'U-1',
                displayName: 'Jane',
                branchId: 'BR-KD',
                payrollGroup: 'branch_ops',
                salaryLevel: 5,
                salaryStep: 1,
                baseSalaryNgn: 400_000,
                housingAllowanceNgn: 50_000,
                transportAllowanceNgn: 20_000,
                profileExtraJson: JSON.stringify({ compensation: { payAdditionNgn: 100_000 } }),
              },
            ],
          };
        }
        if (String(sql).includes('FROM hr_salary_matrix')) {
          return { get: () => matrixRow };
        }
        return { get: () => null, all: () => [], run: () => {} };
      },
    };
    const r = applyBulkMatrixRevisionToProfiles(db, { viewAll: true }, { dryRun: true });
    expect(r.ok).toBe(true);
    expect(r.updatedCount).toBe(1);
    expect(r.updated[0].payAdditionNgn).toBe(100_000);
    expect(r.updated[0].newTotalNgn).toBe(550_000 + 60_000 + 30_000);
  });

  it('buildOrgCompensationDashboardAlerts flags acting roles and review dates', () => {
    const alerts = buildOrgCompensationDashboardAlerts(
      [
        {
          userId: 'U-1',
          displayName: 'Jane Doe',
          branchId: 'BR-KD',
          profileExtra: {
            employmentMeta: {
              secondaryRoles: [
                { role: 'Acting Branch Manager', branchId: 'BR-KD', acting: true, endDateIso: '2026-06-20' },
                { role: 'Cashier', branchId: 'BR-KD', acting: true },
                { role: 'Acting Sales Lead', branchId: 'BR-YL', acting: true, endDateIso: '2026-06-01' },
              ],
            },
            compensationVariance: {
              type: 'multi_role_consolidation',
              reviewDueIso: '2026-06-18',
            },
          },
        },
      ],
      { todayIso: '2026-06-15', withinDays: 30 }
    );
    expect(alerts.actingRolesExpiring).toHaveLength(1);
    expect(alerts.actingRolesOverdue).toHaveLength(1);
    expect(alerts.actingRolesMissingEnd).toHaveLength(1);
    expect(alerts.actingRoleAlerts).toHaveLength(3);
    expect(alerts.compensationReviewDue).toHaveLength(1);
  });

  it('isDirectorCorporateEligible only for MD, board flag, or existing title', () => {
    expect(isDirectorCorporateEligible({ designationId: 'desig_hoa' })).toBe(false);
    expect(isDirectorCorporateEligible({ designationId: 'desig_md' })).toBe(true);
    expect(isDirectorCorporateEligible({ boardMember: true })).toBe(true);
    expect(isDirectorCorporateEligible({ prevExtra: { employmentMeta: { corporateTitle: 'Director' } } })).toBe(true);
  });

  it('buildStaffMergedOffices merges primary and secondary desks', () => {
    const offices = buildStaffMergedOffices({
      designationId: 'desig_hoa',
      jobTitle: 'Head Accountant',
      branchId: 'BR-KD',
      profileExtra: {
        employmentMeta: {
          secondaryRoles: [
            { role: 'Acting Branch Manager', officeKey: 'branch_manager', branchId: 'BR-KD', acting: true },
            { role: 'Cashier', officeKey: 'finance', branchId: 'BR-KD' },
          ],
        },
      },
    });
    expect(offices.length).toBeGreaterThanOrEqual(3);
  });

  it('totalCompensationNgn sums allowances', () => {
    expect(totalCompensationNgn({ baseSalaryNgn: 100, housingAllowanceNgn: 20, transportAllowanceNgn: 5 })).toBe(125);
  });
});
