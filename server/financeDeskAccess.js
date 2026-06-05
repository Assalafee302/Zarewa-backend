/**
 * Phase B3a — server-side finance desk / trial exception visibility (no permission removal).
 */
import { userHasPermission } from './auth.js';

const ACCOUNTING_DESK_ROLES = new Set(['admin', 'md', 'ceo', 'finance_manager']);
const CASHIER_DESK_ROLES = new Set(['cashier']);
const OVERSIGHT_ROLES = new Set(['md', 'ceo', 'admin']);

/**
 * @param {import('./auth.js').SessionUser | null | undefined} user
 */
export function userMayViewFinanceTrialExceptions(user) {
  if (!user) return false;
  if (userHasPermission(user, '*')) return true;
  const rk = String(user.roleKey || user.role_key || '').trim().toLowerCase();
  if (OVERSIGHT_ROLES.has(rk)) return true;
  if (
    userHasPermission(user, 'cashier.desk.view') ||
    userHasPermission(user, 'accounting.desk.view') ||
    userHasPermission(user, 'accounting.reconciliation.view') ||
    userHasPermission(user, 'audit.view') ||
    userHasPermission(user, 'finance.view') ||
    userHasPermission(user, 'finance.pay') ||
    userHasPermission(user, 'reports.view')
  ) {
    return true;
  }
  if (ACCOUNTING_DESK_ROLES.has(rk) || CASHIER_DESK_ROLES.has(rk)) return true;
  return false;
}

/**
 * @param {import('./auth.js').SessionUser | null | undefined} user
 */
export function userMayViewFinanceTrialOversight(user) {
  if (!user) return false;
  if (userHasPermission(user, '*')) return true;
  const rk = String(user.roleKey || user.role_key || '').trim().toLowerCase();
  if (OVERSIGHT_ROLES.has(rk)) return true;
  return userHasPermission(user, 'audit.view');
}

/**
 * AP1c-0 dry-run — Head of Accounts, MD, admin, finance_manager, accounting/reconciliation perms.
 * Excludes cashier-only roles unless they hold accounting permissions.
 * @param {import('./auth.js').SessionUser | null | undefined} user
 */
export function userMayViewAp1cDryRun(user) {
  if (!user) return false;
  if (userHasPermission(user, '*')) return true;
  const rk = String(user.roleKey || user.role_key || '').trim().toLowerCase();
  if (OVERSIGHT_ROLES.has(rk)) return true;
  if (ACCOUNTING_DESK_ROLES.has(rk)) return true;
  if (
    userHasPermission(user, 'accounting.desk.view') ||
    userHasPermission(user, 'accounting.reconciliation.view') ||
    userHasPermission(user, 'finance.view') ||
    userHasPermission(user, 'audit.view')
  ) {
    return true;
  }
  return false;
}

/**
 * AP2a supplier / GRN / payables diagnostics — accounting, finance, MD; not cashier-only.
 * @param {import('./auth.js').SessionUser | null | undefined} user
 */
export function userMayViewAp2SupplierDiagnostics(user) {
  if (!user) return false;
  if (userMayViewAp1cDryRun(user)) return true;
  if (userHasPermission(user, 'procurement.view')) return true;
  const rk = String(user.roleKey || user.role_key || '').trim().toLowerCase();
  if (rk === 'cashier') return false;
  if (userHasPermission(user, 'finance.view') || userHasPermission(user, 'accounting.reconciliation.view')) {
    return true;
  }
  return false;
}
