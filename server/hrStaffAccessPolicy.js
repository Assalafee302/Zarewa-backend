/**
 * ERP access policy for special HR payroll groups (mining, scholarship, domestic).
 * @module server/hrStaffAccessPolicy
 */

import {
  isBeneficiaryOnlyPayrollGroup,
  isErpAccessRestrictedPayrollGroup,
  normalizePayrollGroup,
} from '../shared/lib/hrStaffCohorts.js';

/** App role for staff with no ERP module access — My Profile self-service only. */
export const HR_PORTAL_ONLY_ROLE_KEY = 'hr_portal_only';

export const BENEFICIARY_NO_LOGIN_ERROR =
  'Executive family and household staff do not receive ERP logins. Register them in Chairman Accounts → Executive benefits.';

const ERP_OPERATIONAL_ROLE_KEYS = new Set([
  'admin',
  'md',
  'ceo',
  'chairman',
  'finance_manager',
  'cashier',
  'sales_manager',
  'sales_staff',
  'operations_officer',
  'hr_admin',
  'gmhr',
  'viewer',
]);

/**
 * @param {string | null | undefined} payrollGroup
 */
export function validatePayrollGroupMayHaveLogin(payrollGroup) {
  if (isBeneficiaryOnlyPayrollGroup(payrollGroup)) {
    return { ok: false, error: BENEFICIARY_NO_LOGIN_ERROR };
  }
  return { ok: true };
}

/**
 * @param {string | null | undefined} payrollGroup
 */
export function defaultRoleKeyForPayrollGroup(payrollGroup) {
  if (isBeneficiaryOnlyPayrollGroup(payrollGroup)) return null;
  return isErpAccessRestrictedPayrollGroup(payrollGroup) ? HR_PORTAL_ONLY_ROLE_KEY : 'sales_staff';
}

/**
 * @param {string | null | undefined} roleKey
 * @param {string | null | undefined} payrollGroup
 */
export function validateStaffRoleForPayrollGroup(roleKey, payrollGroup) {
  const pg = normalizePayrollGroup(payrollGroup);
  if (isBeneficiaryOnlyPayrollGroup(pg)) {
    return { ok: false, error: BENEFICIARY_NO_LOGIN_ERROR };
  }
  if (!isErpAccessRestrictedPayrollGroup(pg)) return { ok: true };
  const rk = String(roleKey || '').trim();
  if (rk === HR_PORTAL_ONLY_ROLE_KEY) return { ok: true };
  if (!rk || ERP_OPERATIONAL_ROLE_KEYS.has(rk)) {
    return {
      ok: false,
      error: 'Mining division staff cannot have ERP system roles. Assign the HR portal role or a branch/HQ payroll group.',
    };
  }
  return {
    ok: false,
    error: 'Mining division staff may only use the HR portal role (no sales, finance, or operations access).',
  };
}

/**
 * Force portal-only role when payroll group is mining (ERP-restricted).
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 * @param {string | null | undefined} payrollGroup
 */
export function enforcePortalOnlyRole(db, userId, payrollGroup) {
  if (!isErpAccessRestrictedPayrollGroup(payrollGroup)) return { ok: true, changed: false };
  const uid = String(userId || '').trim();
  const row = db.prepare(`SELECT role_key AS roleKey, permissions_json AS permissionsJson FROM app_users WHERE id = ?`).get(uid);
  if (!row) return { ok: false, error: 'User not found.' };
  const alreadyPortal =
    String(row.roleKey || '') === HR_PORTAL_ONLY_ROLE_KEY && !String(row.permissionsJson || '').trim();
  if (alreadyPortal) return { ok: true, changed: false };
  db.prepare(`UPDATE app_users SET role_key = ?, permissions_json = NULL, department = ? WHERE id = ?`).run(
    HR_PORTAL_ONLY_ROLE_KEY,
    HR_PORTAL_ONLY_ROLE_KEY,
    uid
  );
  return { ok: true, changed: true };
}

/**
 * Legacy cleanup: beneficiary payroll groups must not keep active logins.
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 */
export function suspendLoginForBeneficiaryPayrollGroup(db, userId) {
  const uid = String(userId || '').trim();
  if (!uid) return { ok: true, changed: false };
  try {
    db.prepare(`DELETE FROM user_sessions WHERE user_id = ?`).run(uid);
    const r = db.prepare(`UPDATE app_users SET status = 'suspended' WHERE id = ? AND status = 'active'`).run(uid);
    return { ok: true, changed: (r.changes ?? 0) > 0 };
  } catch {
    return { ok: false, changed: false };
  }
}
