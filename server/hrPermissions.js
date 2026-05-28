/**
 * Canonical HR permission keys and capability helpers for Zarewa ERP.
 * @module server/hrPermissions
 */

import { userHasPermission } from './auth.js';

export { HR_PERMISSION_KEYS } from './hrPermissionKeys.js';

/** Permissions that unlock the Human Resources sidebar module. */
export const HR_MODULE_PERMISSIONS = [
  'hr.directory.view',
  'hr.staff.manage',
  'hr.requests.review',
  'hr.requests.hr_review',
  'hr.requests.gm_approve',
  'hr.requests.final_approve',
  'hr.payroll.prepare',
  'hr.payroll.manage',
  'hr.payroll.gm_approve',
  'hr.payroll.md_approve',
  'hr.payroll.view_sensitive',
  'hr.executive.view',
  'hr.reports.view',
  'hr.settings.manage',
];

const SENSITIVE_VIEW_PERMISSIONS = [
  'hr.payroll.view_sensitive',
  'hr.payroll.prepare',
  'hr.payroll.manage',
  'hr.payroll.gm_approve',
  'hr.payroll.md_approve',
  'hr.staff.manage',
  'hr.executive.view',
  'hr.salary_structure.approve',
  'hr.special_beneficiary.manage',
];

const LEGACY_REVIEW = new Set(['hr.requests.hr_review', 'hr.requests.review']);
const LEGACY_GM = new Set(['hr.requests.gm_approve', 'hr.requests.final_approve']);

/**
 * @param {object | null | undefined} user
 * @param {string} permission
 */
export function hrUserHas(user, permission) {
  if (!permission) return false;
  if (userHasPermission(user, '*')) return true;
  if (userHasPermission(user, permission)) return true;
  if (LEGACY_REVIEW.has(permission)) {
    return [...LEGACY_REVIEW].some((p) => userHasPermission(user, p));
  }
  if (LEGACY_GM.has(permission)) {
    return [...LEGACY_GM].some((p) => userHasPermission(user, p));
  }
  return false;
}

/** @param {object | null | undefined} user */
export function userCanAccessHrModule(user) {
  if (hrUserHas(user, '*')) return true;
  return HR_MODULE_PERMISSIONS.some((p) => hrUserHas(user, p));
}

/** @param {object | null | undefined} user */
export function userCanAccessTeamHr(user) {
  return (
    hrUserHas(user, 'hr.team.view') ||
    hrUserHas(user, 'hr.leave.endorse') ||
    hrUserHas(user, 'hr.attendance.mark') ||
    hrUserHas(user, 'hr.branch.endorse_staff')
  );
}

/** @param {object | null | undefined} user */
export function userCanAccessMyProfileHr(user) {
  return (
    hrUserHas(user, 'hr.self') ||
    hrUserHas(user, 'hr.my_profile.view') ||
    userCanAccessHrModule(user) ||
    userCanAccessTeamHr(user)
  );
}

/**
 * Salary, payroll lines, bank, PAYE, pension (org-wide).
 * @param {object | null | undefined} user
 */
export function userCanViewOrgSensitiveHr(user) {
  if (hrUserHas(user, '*')) return true;
  return SENSITIVE_VIEW_PERMISSIONS.some((p) => hrUserHas(user, p));
}

/**
 * @param {object | null | undefined} user
 * @param {string} [subjectUserId]
 * @param {{ sensitiveUnlocked?: boolean }} [opts]
 */
export function userCanViewStaffCompensation(user, subjectUserId, opts = {}) {
  if (userCanViewOrgSensitiveHr(user)) return true;
  const uid = String(user?.id || '').trim();
  const sub = String(subjectUserId || '').trim();
  if (sub && uid && sub === uid && opts.sensitiveUnlocked) {
    return hrUserHas(user, 'hr.self') || hrUserHas(user, 'hr.my_payslip.view');
  }
  return false;
}

/** @param {object | null | undefined} user */
export function userCanReviewHrRequests(user) {
  return hrUserHas(user, 'hr.requests.review') || hrUserHas(user, 'hr.staff.manage');
}

/** @param {object | null | undefined} user */
export function userCanGmApproveHr(user) {
  return hrUserHas(user, 'hr.requests.gm_approve');
}

/** @param {object | null | undefined} user */
export function userCanEndorseBranchHr(user) {
  return hrUserHas(user, 'hr.branch.endorse_staff') || hrUserHas(user, 'hr.leave.endorse');
}

/** @param {object | null | undefined} user */
export function userCanPreparePayroll(user) {
  return hrUserHas(user, 'hr.payroll.prepare') || hrUserHas(user, 'hr.payroll.manage');
}

/** @param {object | null | undefined} user */
export function userCanGmApprovePayroll(user) {
  return hrUserHas(user, 'hr.payroll.gm_approve');
}

/** @param {object | null | undefined} user */
export function userCanMdApprovePayroll(user) {
  return hrUserHas(user, 'hr.payroll.md_approve') || hrUserHas(user, 'hr.executive.view');
}

/** @param {object | null | undefined} user */
export function userCanPayPayroll(user) {
  return hrUserHas(user, 'hr.payroll.pay') || hrUserHas(user, 'finance.pay');
}

/** @param {object | null | undefined} user */
export function userCanMarkBranchContribution(user) {
  return hrUserHas(user, 'hr.branch_contribution.mark') || hrUserHas(user, 'hr.executive.view');
}

export { HR_ROLE_PERMISSION_BUNDLES } from './hrRoleBundles.js';
