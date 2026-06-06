export const HR_POLICY_REGISTRY = [
  {
    key: 'employee_handbook',
    version: '2026.04',
    label: 'Employee handbook',
    requiredFor: ['hr_staff_edit', 'hr_payroll'],
  },
  {
    key: 'it_security',
    version: '2026.04',
    label: 'Computer & information security',
    requiredFor: ['hr_staff_edit', 'hr_payroll', 'hr_sensitive_view'],
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
  },
  {
    key: 'confidentiality_pledge',
    version: '1.0',
    label: 'Confidentiality Pledge',
    description: 'I acknowledge that all information relating to Zarewa Aluminium & Plastics Ltd, its sister companies, customers, employees, and records must not be disclosed to unauthorized persons during or after employment.',
    requiredForActions: ['hr_staff_edit', 'hr_payroll', 'hr_view_sensitive'],
    mustSignOnJoining: true,
  },
];

export function requiredHrPoliciesFor(actionKey) {
  return HR_POLICY_REGISTRY.filter((p) => (p.requiredFor || []).includes(actionKey)).map((p) => ({
    key: p.key,
    version: p.version,
    label: p.label,
  }));
}

