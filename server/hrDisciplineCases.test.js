import { describe, expect, it } from 'vitest';
import {
  DISCIPLINE_CASE_STATUSES,
  DISCIPLINE_CASE_TYPES,
  DISCIPLINE_SEVERITIES,
} from './hrDisciplineCasesOps.js';
import { HR_POLICY_GATED_ACTIONS, HR_POLICY_REGISTRY, requiredHrPoliciesFor } from './hrPolicy.js';
import { HR_REPORT_CATALOG } from './hrReportsHub.js';

describe('hrDisciplineCasesOps constants', () => {
  it('defines case types and workflow statuses', () => {
    expect(DISCIPLINE_CASE_TYPES).toContain('query');
    expect(DISCIPLINE_CASE_TYPES).toContain('dismissal_recommendation');
    expect(DISCIPLINE_CASE_STATUSES).toContain('awaiting_management_decision');
    expect(DISCIPLINE_SEVERITIES).toContain('critical');
  });
});

describe('hrPolicy Phase 7', () => {
  it('includes expanded policy registry', () => {
    const keys = HR_POLICY_REGISTRY.map((p) => p.key);
    expect(keys).toContain('code_of_conduct');
    expect(keys).toContain('anti_harassment');
    expect(keys).toContain('data_protection');
  });

  it('gates leave approval and payroll edit actions', () => {
    expect(requiredHrPoliciesFor('hr_leave_approve').length).toBeGreaterThan(0);
    expect(requiredHrPoliciesFor('hr_payroll_edit').length).toBeGreaterThan(0);
    expect(HR_POLICY_GATED_ACTIONS.hr_approvals.length).toBeGreaterThan(2);
  });
});

describe('hrReportsHub Phase 7 reports', () => {
  it('includes discipline case and letter reports', () => {
    const ids = HR_REPORT_CATALOG.map((r) => r.id);
    expect(ids).toContain('discipline-cases-open');
    expect(ids).toContain('discipline-pending-decision');
    expect(ids).toContain('letter-issuance-report');
  });
});
