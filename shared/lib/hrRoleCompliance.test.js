import { describe, expect, it } from 'vitest';
import {
  HR_ROLE_COMPLIANCE_META,
  computeRoleCompliance,
  hrRoleComplianceMeta,
} from './hrRoleCompliance.js';

describe('hrRoleComplianceMeta', () => {
  it('labels ok and needs_attention so they are not colour-only', () => {
    expect(HR_ROLE_COMPLIANCE_META.ok.label).toBe('Role compliance: ok');
    expect(HR_ROLE_COMPLIANCE_META.needs_attention.label).toBe('Role compliance: needs attention');
    expect(hrRoleComplianceMeta('ok').label).toMatch(/^Role compliance:/);
    expect(hrRoleComplianceMeta('needs_attention').label).toMatch(/^Role compliance:/);
  });
});

describe('computeRoleCompliance', () => {
  const now = Date.parse('2026-08-19');

  it('stays ok when the role has no min rank and no max tenure', () => {
    const r = computeRoleCompliance({ designationTitle: 'Cleaner' }, now);
    expect(r.status).toBe('ok');
    expect(r.reason).toBeNull();
  });

  it('needs attention when held rank is below the role minimum', () => {
    const r = computeRoleCompliance(
      {
        designationTitle: 'Estimator',
        minQualificationRank: 4,
        qualificationRank: 2,
      },
      now
    );
    expect(r.status).toBe('needs_attention');
    expect(r.reason).toMatch(/Held qualification rank 2 is below minimum rank 4 for Estimator/);
  });

  it('needs attention when a minimum is set but held rank is missing', () => {
    const r = computeRoleCompliance({ designationTitle: 'Estimator', minQualificationRank: 4 }, now);
    expect(r.status).toBe('needs_attention');
    expect(r.reason).toMatch(/Qualification not recorded/);
  });

  it('needs attention when years in role exceed max tenure', () => {
    const r = computeRoleCompliance(
      {
        designationTitle: 'Sales Officer',
        maxTenureYears: 5,
        roleStartedAtIso: '2018-01-01',
        qualificationRank: 4,
        minQualificationRank: 3,
      },
      now
    );
    expect(r.status).toBe('needs_attention');
    expect(r.reason).toMatch(/maximum tenure is 5 years/);
  });

  it('needs attention when max tenure is set but role start is missing', () => {
    const r = computeRoleCompliance(
      { designationTitle: 'Sales Officer', maxTenureYears: 5, minQualificationRank: 1, qualificationRank: 2 },
      now
    );
    expect(r.status).toBe('needs_attention');
    expect(r.reason).toMatch(/Role start date missing/);
  });
});
