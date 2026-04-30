/**
 * Workspace department ids align with the in-app team guide (Settings → Team guide).
 * Used for onboarding defaults and UI shortcuts — access control remains permission-based.
 */

export const WORKSPACE_DEPARTMENT_IDS = [
  'general',
  'customer',
  'sales',
  'inventory',
  'production',
  'purchase',
  'finance',
  'reports',
  'it',
];

/** Suggested role when creating a user for a department (HR/admin still assigns the real role). */
export const SUGGESTED_ROLE_BY_DEPARTMENT = {
  general: 'viewer',
  customer: 'sales_staff',
  sales: 'sales_staff',
  inventory: 'operations_officer',
  production: 'operations_officer',
  purchase: 'procurement_officer',
  finance: 'finance_manager',
  reports: 'viewer',
  it: 'admin',
};

export function normalizeWorkspaceDepartment(raw) {
  const s = String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_');
  if (WORKSPACE_DEPARTMENT_IDS.includes(s)) return s;
  return 'general';
}

export function suggestedRoleKeyForDepartment(dep) {
  const id = normalizeWorkspaceDepartment(dep);
  return SUGGESTED_ROLE_BY_DEPARTMENT[id] || 'viewer';
}
