export const HR_POLICY_REGISTRY = [
  {
    key: 'employee_handbook',
    version: '2026.04',
    label: 'Employee handbook',
    requiredFor: ['hr_staff_edit', 'hr_payroll', 'hr_approvals'],
    mustSignOnJoining: true,
  },
  {
    key: 'it_security',
    version: '2026.04',
    label: 'Computer & information security',
    requiredFor: ['hr_staff_edit', 'hr_payroll', 'hr_sensitive_view', 'hr_approvals'],
    mustSignOnJoining: true,
  },
  {
    key: 'attendance_policy',
    version: '2026.04',
    label: 'Hours, attendance & punctuality',
    requiredFor: ['hr_attendance_upload'],
  },
  {
    key: 'eeo_policy',
    version: '2026.04',
    label: 'Equal employment opportunity (EEO)',
    requiredFor: ['hr_approvals'],
    mustSignOnJoining: true,
  },
  {
    key: 'confidentiality_pledge',
    version: '2026.07',
    label: 'Confidentiality pledge',
    description:
      'I acknowledge that all information relating to Zarewa Aluminium & Plastics Ltd, its sister companies, customers, employees, and records must not be disclosed to unauthorized persons during or after employment.',
    requiredFor: ['hr_staff_edit', 'hr_payroll', 'hr_view_sensitive', 'hr_approvals'],
    mustSignOnJoining: true,
  },
  {
    key: 'code_of_conduct',
    version: '2026.07',
    label: 'Code of conduct',
    requiredFor: ['hr_approvals', 'hr_leave_approve'],
    mustSignOnJoining: true,
  },
  {
    key: 'anti_harassment',
    version: '2026.07',
    label: 'Anti-harassment policy',
    requiredFor: ['hr_approvals'],
    mustSignOnJoining: true,
  },
  {
    key: 'data_protection',
    version: '2026.07',
    label: 'Data protection & privacy',
    requiredFor: ['hr_staff_edit', 'hr_sensitive_view'],
    mustSignOnJoining: true,
  },
  {
    key: 'conflict_of_interest',
    version: '2026.07',
    label: 'Conflict of interest declaration',
    requiredFor: ['hr_approvals'],
  },
];

/** Actions that require policy acknowledgement before proceeding. */
export const HR_POLICY_GATED_ACTIONS = {
  hr_leave_approve: ['employee_handbook', 'code_of_conduct', 'eeo_policy'],
  hr_payroll_edit: ['employee_handbook', 'it_security', 'confidentiality_pledge'],
  hr_approvals: ['employee_handbook', 'eeo_policy', 'code_of_conduct', 'confidentiality_pledge'],
};

export function requiredHrPoliciesFor(actionKey) {
  const gated = HR_POLICY_GATED_ACTIONS[actionKey];
  if (gated?.length) {
    return HR_POLICY_REGISTRY.filter((p) => gated.includes(p.key)).map((p) => ({
      key: p.key,
      version: p.version,
      label: p.label,
    }));
  }
  return HR_POLICY_REGISTRY.filter((p) => (p.requiredFor || []).includes(actionKey)).map((p) => ({
    key: p.key,
    version: p.version,
    label: p.label,
  }));
}

export function joiningHrPolicies() {
  return HR_POLICY_REGISTRY.filter((p) => p.mustSignOnJoining).map((p) => ({
    key: p.key,
    version: p.version,
    label: p.label,
  }));
}
