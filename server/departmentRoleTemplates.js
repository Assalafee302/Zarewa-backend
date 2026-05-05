/**
 * Workspace "department" is aligned with the user's role key (single source of truth).
 * Legacy department strings from older installs are mapped onto a valid role.
 */

/** Canonical role keys (mirror server/auth.js ROLE_DEFINITIONS). */
export const WORKSPACE_ROLE_KEYS = [
  'admin',
  'md',
  'finance_manager',
  'sales_manager',
  'sales_staff',
  'cashier',
  'operations_officer',
];

const LEGACY_DEPARTMENT_TO_ROLE = {
  general: 'sales_staff',
  customer: 'sales_staff',
  sales: 'sales_staff',
  /** Stock receipts / book adjustments: branch manager+ only (see auth inventory.*). */
  inventory: 'sales_manager',
  production: 'operations_officer',
  purchase: 'md',
  finance: 'finance_manager',
  reports: 'sales_staff',
  it: 'admin',
  leadership: 'md',
  hr: 'sales_staff',
};

/** @deprecated Use WORKSPACE_ROLE_KEYS — kept for bootstrap field name compatibility. */
export const WORKSPACE_DEPARTMENT_IDS = [...WORKSPACE_ROLE_KEYS, ...Object.keys(LEGACY_DEPARTMENT_TO_ROLE)];

/** Suggested role for a stored workspace label (always the canonical role key). */
export const SUGGESTED_ROLE_BY_DEPARTMENT = Object.fromEntries(
  WORKSPACE_DEPARTMENT_IDS.map((id) => [id, normalizeWorkspaceDepartment(id)])
);

export function normalizeWorkspaceDepartment(raw) {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
  if (WORKSPACE_ROLE_KEYS.includes(s)) return s;
  if (LEGACY_DEPARTMENT_TO_ROLE[s]) return LEGACY_DEPARTMENT_TO_ROLE[s];
  return 'sales_staff';
}

export function suggestedRoleKeyForDepartment(dep) {
  return normalizeWorkspaceDepartment(dep);
}
