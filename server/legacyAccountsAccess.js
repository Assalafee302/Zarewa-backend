/**
 * Phase 10 — legacy `/accounts` route and tab RBAC (server).
 * Cashier Desk and Accounting Desk remain primary; `/accounts` is restricted by role/tab.
 */
import { userHasPermission } from './auth.js';

export const LEGACY_ACCOUNT_TAB_IDS = ['desk', 'treasury', 'receipts', 'movements', 'disbursements', 'audit'];

const ROLE_BRANCH_MANAGER = 'sales_manager';
const ROLE_CASHIER = 'cashier';
const ROLE_ACCOUNTANT = 'finance_manager';
const OVERSIGHT_ROLES = new Set(['admin', 'md']);

/** Cashier: Desk (accounts & statements merged) + receipts + movements. */
const CASHIER_LEGACY_TABS = new Set(['desk', 'receipts', 'movements']);

/** Accountant / Head of Accounts — reconciliation and oversight tabs. */
const ACCOUNTANT_LEGACY_TABS = new Set(['treasury', 'receipts', 'movements', 'disbursements', 'audit']);

/**
 * @param {object | null | undefined} user
 */
export function userMayAccessLegacyAccountsRoute(user) {
  if (!user) return false;
  if (userHasPermission(user, '*')) return true;
  const rk = String(user.roleKey || user.role_key || '').trim().toLowerCase();
  if (OVERSIGHT_ROLES.has(rk)) return true;
  if (rk === ROLE_BRANCH_MANAGER) return false;
  if (rk === ROLE_CASHIER) {
    return (
      userHasPermission(user, 'cashier.desk.view') ||
      userHasPermission(user, 'finance.pay') ||
      userHasPermission(user, 'treasury.manage') ||
      userHasPermission(user, 'receipts.post')
    );
  }
  if (rk === ROLE_ACCOUNTANT) {
    return (
      userHasPermission(user, 'accounting.desk.view') ||
      userHasPermission(user, 'accounting.reconciliation.view') ||
      userHasPermission(user, 'finance.view')
    );
  }
  if (userHasPermission(user, 'finance.view')) return true;
  return false;
}

/**
 * @param {object | null | undefined} user
 * @returns {string[]}
 */
export function getAllowedLegacyAccountTabs(user) {
  if (!user) return [];
  if (userHasPermission(user, '*')) return [...LEGACY_ACCOUNT_TAB_IDS];
  const rk = String(user.roleKey || user.role_key || '').trim().toLowerCase();
  if (OVERSIGHT_ROLES.has(rk)) return [...LEGACY_ACCOUNT_TAB_IDS];
  if (rk === ROLE_BRANCH_MANAGER) return [];
  if (rk === ROLE_CASHIER) {
    return LEGACY_ACCOUNT_TAB_IDS.filter((t) => CASHIER_LEGACY_TABS.has(t));
  }
  if (rk === ROLE_ACCOUNTANT) {
    return LEGACY_ACCOUNT_TAB_IDS.filter((t) => ACCOUNTANT_LEGACY_TABS.has(t));
  }
  if (userHasPermission(user, 'accounting.gl.view') || userHasPermission(user, 'accounting.reconciliation.view')) {
    return LEGACY_ACCOUNT_TAB_IDS.filter((t) => ACCOUNTANT_LEGACY_TABS.has(t));
  }
  if (userHasPermission(user, 'finance.view')) {
    return ['treasury', 'receipts', 'disbursements'];
  }
  return [];
}

/**
 * @param {object | null | undefined} user
 * @returns {string}
 */
export function getDefaultLegacyAccountTab(user) {
  const allowed = getAllowedLegacyAccountTabs(user);
  const rk = String(user?.roleKey || user?.role_key || '').trim().toLowerCase();
  if (rk === ROLE_CASHIER && allowed.includes('desk')) return 'desk';
  if (allowed.includes('treasury')) return 'treasury';
  return allowed[0] || 'treasury';
}

/**
 * @param {object | null | undefined} user
 * @param {string} [tabId]
 * @returns {{ to: string; reason: string } | null}
 */
export function resolveLegacyAccountsRedirect(user, tabId = '') {
  if (!user) return { to: '/', reason: 'unauthenticated' };
  const rk = String(user.roleKey || user.role_key || '').trim().toLowerCase();
  if (rk === ROLE_BRANCH_MANAGER) return { to: '/manager', reason: 'branch_manager' };
  if (!userMayAccessLegacyAccountsRoute(user)) {
    if (rk === ROLE_CASHIER) return { to: '/accounts', reason: 'cashier_finance' };
    if (rk === ROLE_ACCOUNTANT) return { to: '/accounting', reason: 'accounting_desk' };
    return { to: '/', reason: 'denied' };
  }
  const tab = String(tabId || '').trim().toLowerCase();
  if (!tab) return null;
  const allowed = getAllowedLegacyAccountTabs(user);
  if (allowed.includes(tab)) return null;
  if (rk === ROLE_CASHIER) {
    const fallback = getDefaultLegacyAccountTab(user);
    return {
      to: fallback === 'treasury' ? '/accounts' : `/accounts?tab=${fallback}`,
      reason: 'tab_denied',
    };
  }
  if (rk === ROLE_ACCOUNTANT) return { to: '/accounting', reason: 'tab_denied' };
  const fallback = allowed[0] || 'treasury';
  return { to: fallback === 'treasury' ? '/accounts' : `/accounts?tab=${fallback}`, reason: 'tab_denied' };
}

/**
 * GL / audit APIs — block cashier and branch manager even when finance.view is present.
 * @param {object | null | undefined} user
 */
export function userMayAccessAccountingGlApis(user) {
  if (!user) return false;
  if (userHasPermission(user, '*')) return true;
  const rk = String(user.roleKey || user.role_key || '').trim().toLowerCase();
  if (rk === ROLE_CASHIER || rk === ROLE_BRANCH_MANAGER) return false;
  if (OVERSIGHT_ROLES.has(rk) || rk === ROLE_ACCOUNTANT) return true;
  return (
    userHasPermission(user, 'accounting.gl.view') ||
    userHasPermission(user, 'accounting.reconciliation.view') ||
    userHasPermission(user, 'accounting.desk.view')
  );
}
