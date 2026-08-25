/**
 * Legacy quotations stored role titles as handled_by (e.g. "Branch Manager")
 * before the login display name was updated to the person's real name.
 */

export function normalizePreparedByLabel(label) {
  return String(label || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** Role keys that own the Branch Manager desk. */
export const BRANCH_MANAGER_ROLE_KEYS = ['sales_manager', 'branch_manager'];

/**
 * @param {string} label
 * @returns {string[]} role keys, or empty when label is a person name
 */
export function roleKeysForPreparedByLabel(label) {
  const n = normalizePreparedByLabel(label);
  if (!n) return [];
  if (
    n === 'branch manager' ||
    n === 'bm' ||
    n === 'sales manager' ||
    n === 'branch mgr' ||
    n === 'b.manager' ||
    n === 'b manager'
  ) {
    return [...BRANCH_MANAGER_ROLE_KEYS];
  }
  return [];
}

export function isBranchManagerPreparedByLabel(label) {
  return roleKeysForPreparedByLabel(label).length > 0;
}

/**
 * True when prepared-by text is a BM role title and the payee is a BM-role login.
 * @param {string} label
 * @param {{ roleKey?: string } | null | undefined} payee
 */
export function preparedByRoleTitleAgreesWithPayee(label, payee) {
  const keys = roleKeysForPreparedByLabel(label);
  if (!keys.length) return false;
  const rk = String(payee?.roleKey || '')
    .trim()
    .toLowerCase();
  return Boolean(rk && keys.includes(rk));
}
