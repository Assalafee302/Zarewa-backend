/**
 * Phase 10 — legacy `/accounts` route and tab RBAC (server).
 * Finance desk merges legacy Desk + Treasury tabs (canonical tab id: `desk`).
 */
import { userHasPermission } from './auth.js';

export const LEGACY_ACCOUNT_TAB_IDS = ['desk', 'treasury', 'receipts', 'movements', 'disbursements', 'audit'];

export const FINANCE_DESK_TAB_ID = 'desk';

const ROLE_BRANCH_MANAGER = 'sales_manager';
const ROLE_CASHIER = 'cashier';
const ROLE_ACCOUNTANT = 'finance_manager';
const OVERSIGHT_ROLES = new Set(['admin', 'md']);

/** Cashier: desk, receipts, transfers, and payouts. */
const CASHIER_LEGACY_TABS = new Set(['desk', 'receipts', 'movements', 'disbursements']);

/** Accountant — Finance desk replaces legacy Treasury tab. */
const ACCOUNTANT_LEGACY_TABS = new Set(['desk', 'receipts', 'movements', 'disbursements', 'audit']);

function withoutRetiredTreasuryTab(tabs) {
  return tabs.filter((t) => t !== 'treasury');
}

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
  if (userHasPermission(user, '*')) return withoutRetiredTreasuryTab([...LEGACY_ACCOUNT_TAB_IDS]);
  const rk = String(user.roleKey || user.role_key || '').trim().toLowerCase();
  if (OVERSIGHT_ROLES.has(rk)) return withoutRetiredTreasuryTab([...LEGACY_ACCOUNT_TAB_IDS]);
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
    return ['desk', 'receipts', 'disbursements'];
  }
  return [];
}

/**
 * @param {object | null | undefined} user
 * @returns {string}
 */
export function getDefaultLegacyAccountTab(user) {
  const allowed = getAllowedLegacyAccountTabs(user);
  if (allowed.includes(FINANCE_DESK_TAB_ID)) return FINANCE_DESK_TAB_ID;
  return allowed[0] || FINANCE_DESK_TAB_ID;
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
  const normalizedTab = tab === 'treasury' ? FINANCE_DESK_TAB_ID : tab;
  const allowed = getAllowedLegacyAccountTabs(user);
  if (allowed.includes(normalizedTab) || tab === 'treasury') return null;
  if (rk === ROLE_ACCOUNTANT) return { to: '/accounting', reason: 'tab_denied' };
  const fallback = getDefaultLegacyAccountTab(user);
  return { to: `/accounts?tab=${encodeURIComponent(fallback)}`, reason: 'tab_denied' };
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
