import { describe, expect, it } from 'vitest';
import {
  suggestTenurePayActions,
  validateActingEndDate,
  validateStaffTenureForSave,
  resolveDesignationMinServiceYears,
} from './hrTenureOps.js';

describe('hrTenureOps', () => {
  it('suggestTenurePayActions recommends step 2 after 2 years at level', () => {
    const s = suggestTenurePayActions({ yearsOfService: 2.5, yearsInCurrentLevel: 2.1, salaryStep: 1 });
    expect(s.some((x) => x.type === 'step_increment' && x.suggestedStep === 2)).toBe(true);
  });

  it('validateActingEndDate rejects appointments over 6 months', () => {
    const end = new Date();
    end.setMonth(end.getMonth() + 8);
    const r = validateActingEndDate(end.toISOString().slice(0, 10));
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/6 months/i);
  });

  it('resolveDesignationMinServiceYears uses title tier default', () => {
    expect(resolveDesignationMinServiceYears({ titleTier: 'manager' })).toBe(3);
    expect(resolveDesignationMinServiceYears({ minServiceYears: 5, titleTier: 'manager' })).toBe(5);
  });

  it('validateStaffTenureForSave blocks BM without enough service', () => {
    const db = {
      prepare: (sql) => {
        const s = String(sql);
        if (s.includes('sqlite_master')) {
          return { get: () => ({ 1: 1 }) };
        }
        if (s.includes('hr_designations')) {
          return {
            get: () => ({
              id: 'desig_bm',
              title: 'Branch Manager',
              grade_category: 'G4-G5',
              seniority_band: 'leadership',
              default_salary_level: 5,
              default_salary_step: 1,
              min_service_years: 5,
              title_tier: 'manager',
              is_acting: 0,
              department_id: 'dept_branch',
              departmentName: 'Branch',
            }),
          };
        }
        if (s.includes('role_key')) return { get: () => ({ role_key: 'hr_admin' }) };
        if (s.includes('salary_history')) return { get: () => null };
        return { get: () => null };
      },
    };
    const joined = new Date();
    joined.setFullYear(joined.getFullYear() - 1);
    const r = validateStaffTenureForSave(db, {
      userId: 'U-1',
      designationId: 'desig_bm',
      dateJoinedIso: joined.toISOString().slice(0, 10),
      actorUserId: 'A-1',
    });
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/5 year/i);
  });
});
