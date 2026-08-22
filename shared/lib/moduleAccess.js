/**
 * Shared module visibility rules (keep in sync with server-side workspace filters).
 * Frontend copies via `npm run sync:shared` → src/shared/lib/moduleAccess.js
 * Unknown module keys are denied.
 */

export function hasPermissionInList(permissions, permission) {
  if (!Array.isArray(permissions) || !permission) return false;
  return permissions.includes('*') || permissions.includes(permission);
}

/** Canonical RBAC matrix for module visibility. */
export const MODULE_ACCESS_POLICY = {
  sales: ['sales.view', 'sales.manage', 'quotations.manage', 'receipts.post'],
  procurement: ['procurement.view', 'purchase_orders.manage'],
  operations: [
    'operations.view',
    'operations.manage',
    'production.manage',
    'production.release',
    'inventory.receive',
    'inventory.adjust',
    'deliveries.manage',
  ],
  finance: [
    'finance.view',
    'finance.post',
    'finance.pay',
    'finance.approve',
    'finance.reverse',
    'treasury.manage',
    'cashier.desk.view',
    'cashier.receipts.confirm',
    'accounting.desk.view',
    'accounting.reconciliation.view',
    'accounting.gl.view',
  ],
  cashier_desk: ['cashier.desk.view', 'finance.pay', 'treasury.manage', 'receipts.post'],
  accounting_desk: [
    'accounting.desk.view',
    'accounting.reconciliation.view',
    'accounting.gl.view',
    'finance.view',
    'reports.view',
  ],
  reports: ['reports.view'],
  edit_approvals: ['dashboard.view'],
  settings: ['settings.view', 'settings.manage', 'period.manage'],
  office: ['office.use'],
  hr: [
    'hr.directory.view',
    'hr.staff.manage',
    'hr.requests.review',
    'hr.requests.hr_review',
    'hr.requests.gm_approve',
    'hr.requests.final_approve',
    'hr.payroll.prepare',
    'hr.payroll.manage',
    'hr.payroll.gm_approve',
    'hr.reports.view',
    'hr.settings.manage',
    'hr.letters.generate',
    'hr.letters.approve',
    'hr.staff.import',
  ],
  team_hr: [
    'hr.team.view',
    'hr.attendance.mark',
    'hr.daily_roll.mark',
    'hr.leave.endorse',
    'hr.loan.endorse',
    'hr.branch.endorse_staff',
  ],
  my_profile_hr: [
    'hr.self',
    'hr.my_profile.view',
    'hr.my_leave.request',
    'hr.my_loan.request',
    'hr.my_attendance.view',
    'hr.my_payslip.view',
    'hr.my_documents.view',
  ],
  executive_hr: [
    'hr.executive.view',
    'hr.branch_contribution.mark',
    'hr.executive.benefits.view',
    'hr.executive.benefits.manage',
    'hr.chairman.manage',
  ],
  exec: ['exec.dashboard.view', 'dashboard.view'],
};

/** Cashiers work in Finance only — receipts.post must not expose the Sales module. */
export const SALES_MODULE_EXCLUDED_ROLE_KEYS = new Set(['cashier']);

export function userMayAccessSalesModule(roleKey, permissions) {
  const rk = String(roleKey || '').trim().toLowerCase();
  if (SALES_MODULE_EXCLUDED_ROLE_KEYS.has(rk)) return false;
  return canAccessModuleWithPermissions(permissions, 'sales');
}

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
    case 'cashier_desk':
      return MODULE_ACCESS_POLICY.cashier_desk.some(has);
    case 'accounting_desk':
      return MODULE_ACCESS_POLICY.accounting_desk.some(has);
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
    case 'hr':
      return MODULE_ACCESS_POLICY.hr.some(has);
    case 'team_hr':
      return MODULE_ACCESS_POLICY.team_hr.some(has);
    case 'my_profile_hr':
      return (
        MODULE_ACCESS_POLICY.my_profile_hr.some(has) ||
        MODULE_ACCESS_POLICY.hr.some(has) ||
        MODULE_ACCESS_POLICY.team_hr.some(has)
      );
    case 'executive_hr':
      return MODULE_ACCESS_POLICY.executive_hr.some(has);
    case 'exec':
      return MODULE_ACCESS_POLICY.exec.some(has) || has('*');
    default:
      return false;
  }
}
