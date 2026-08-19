import { describe, expect, it } from 'vitest';
import {
  periodEndIso,
  resolveSalaryStructureFromIndex,
} from './hrSalaryStructureOps.js';

describe('salary structure resolve', () => {
  const index = [
    {
      id: 'v-branch',
      designation_id: 'desig_sales',
      branch_id: 'BR-KD',
      amount_ngn: 180000,
      status: 'current',
      effective_from_iso: '2026-01-01',
    },
    {
      id: 'v-hq',
      designation_id: 'desig_sales',
      branch_id: '',
      amount_ngn: 150000,
      status: 'current',
      effective_from_iso: '2025-01-01',
    },
    {
      id: 'v-old',
      designation_id: 'desig_sales',
      branch_id: '',
      amount_ngn: 120000,
      status: 'superseded',
      effective_from_iso: '2024-01-01',
    },
    {
      id: 'v-proposed',
      designation_id: 'desig_sales',
      branch_id: '',
      amount_ngn: 200000,
      status: 'proposed',
      effective_from_iso: '2026-01-01',
    },
  ];

  it('prefers branch-specific current over company-wide', () => {
    const hit = resolveSalaryStructureFromIndex(index, {
      designationId: 'desig_sales',
      branchId: 'BR-KD',
      asOfIso: '2026-08-01',
    });
    expect(hit.id).toBe('v-branch');
    expect(hit.amount_ngn).toBe(180000);
  });

  it('falls back to company-wide when the branch has no row', () => {
    const hit = resolveSalaryStructureFromIndex(index, {
      designationId: 'desig_sales',
      branchId: 'BR-YL',
      asOfIso: '2026-08-01',
    });
    expect(hit.id).toBe('v-hq');
  });

  it('ignores proposed rows', () => {
    const hit = resolveSalaryStructureFromIndex(index, {
      designationId: 'desig_sales',
      branchId: '',
      asOfIso: '2026-08-01',
    });
    expect(hit.id).toBe('v-hq');
  });

  it('uses superseded history when as-of is before the current effective date', () => {
    const hit = resolveSalaryStructureFromIndex(index, {
      designationId: 'desig_sales',
      branchId: '',
      asOfIso: '2024-06-01',
    });
    expect(hit.id).toBe('v-old');
  });

  it('periodEndIso is the last calendar day of the payroll month', () => {
    expect(periodEndIso('202608')).toBe('2026-08-31');
    expect(periodEndIso('202602')).toBe('2026-02-28');
  });
});
