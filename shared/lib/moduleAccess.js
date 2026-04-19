/** Shared module visibility rules (keep in sync with server-side workspace filters). */

export function hasPermissionInList(permissions, permission) {
  if (!Array.isArray(permissions) || !permission) return false;
  return permissions.includes('*') || permissions.includes(permission);
}

/** Canonical client-side RBAC matrix for module visibility. */
export const MODULE_ACCESS_POLICY = {
  sales: ['sales.view', 'sales.manage', 'quotations.manage', 'receipts.post'],
  procurement: ['procurement.view', 'purchase_orders.manage'],
  operations: ['operations.view', 'production.manage'],
  finance: [
    'finance.view',
    'finance.post',
    'finance.pay',
    'finance.approve',
    'finance.reverse',
    'treasury.manage',
  ],
  reports: ['reports.view'],
  edit_approvals: ['dashboard.view'],
  settings: ['settings.view', 'period.manage'],
  office: ['office.use'],
};

export function canAccessModuleWithPermissions(permissions, moduleKey) {
  const has = (p) => hasPermissionInList(permissions, p);
  switch (moduleKey) {
    case 'sales':
      return MODULE_ACCESS_POLICY.sales.some(has);
    case 'procurement':
      return MODULE_ACCESS_POLICY.procurement.some(has);
    case 'operations':
      return MODULE_ACCESS_POLICY.operations.some(has);
    case 'finance':
      return MODULE_ACCESS_POLICY.finance.some(has);
    case 'reports':
      return MODULE_ACCESS_POLICY.reports.some(has);
    case 'edit_approvals':
      // Route is further restricted by role in WorkspaceContext (edit approvers only).
      return MODULE_ACCESS_POLICY.edit_approvals.some(has);
    case 'settings':
      // Settings is an administrative module; audit viewers should not automatically gain access.
      return MODULE_ACCESS_POLICY.settings.some(has);
    case 'office':
      return MODULE_ACCESS_POLICY.office.some(has) || has('*');
    default:
      return true;
  }
}
