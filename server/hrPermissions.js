/**
 * Canonical HR permission keys and capability helpers for Zarewa ERP.
 * @module server/hrPermissions
 */

import { userHasPermission } from './auth.js';

export { HR_PERMISSION_KEYS } from './hrPermissionKeys.js';

/** Permissions that unlock the Human Resources sidebar module (/hr/*). Team-only keys are excluded. */
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
  'hr.reports.view',
  'hr.settings.manage',
  'hr.letters.generate',
  'hr.letters.approve',
  'hr.staff.import',
];

/** Executive-only keys — do not unlock main HR admin workspace (Phase 10). */
export const HR_EXECUTIVE_ONLY_PERMISSIONS = ['hr.executive.view', 'hr.payroll.md_approve'];

/** Main /hr/* workspace — excludes executive-only MD keys. */
export const MAIN_HR_WORKSPACE_PERMISSIONS = [...HR_MODULE_PERMISSIONS];

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
export function userCanAccessMainHrWorkspace(user) {
  if (hrUserHas(user, '*')) return true;
  return MAIN_HR_WORKSPACE_PERMISSIONS.some((p) => hrUserHas(user, p));
}

/** @param {object | null | undefined} user */
export function userCanAccessExecutiveHrModule(user) {
  if (hrUserHas(user, '*')) return true;
  return HR_EXECUTIVE_ONLY_PERMISSIONS.some((p) => hrUserHas(user, p));
}

/** @param {object | null | undefined} user */
export function userCanApproveHrLetters(user) {
  return hrUserHas(user, 'hr.letters.approve') || hrUserHas(user, 'hr.staff.manage');
}

/** @param {object | null | undefined} user */
export function userCanBulkImportStaff(user) {
  return hrUserHas(user, 'hr.staff.import') || hrUserHas(user, 'hr.staff.manage');
}

/** @param {object | null | undefined} user */
export function userCanViewExecutiveBenefits(user) {
  if (hrUserHas(user, '*')) return true;
  return (
    hrUserHas(user, 'hr.executive.benefits.view') ||
    hrUserHas(user, 'hr.executive.benefits.manage') ||
    hrUserHas(user, 'hr.chairman.manage') ||
    hrUserHas(user, 'hr.special_beneficiary.manage') ||
    hrUserHas(user, 'hr.executive.view')
  );
}

/** @param {object | null | undefined} user */
export function userCanManageExecutiveBenefits(user) {
  if (hrUserHas(user, '*')) return true;
  return (
    hrUserHas(user, 'hr.executive.benefits.manage') ||
    hrUserHas(user, 'hr.chairman.manage') ||
    hrUserHas(user, 'hr.special_beneficiary.manage') ||
    hrUserHas(user, 'hr.payroll.md_approve')
  );
}

/** API paths self-service staff may call without main HR workspace. */
export const HR_SELF_SERVICE_API_PATTERNS = [
  /^\/api\/hr\/health$/,
  /^\/api\/hr\/notification-summary$/,
  /^\/api\/hr\/my(\/|$)/,
  /^\/api\/hr\/team(\/|$)/,
  /^\/api\/hr\/me$/,
  /^\/api\/hr\/policy-requirements$/,
  /^\/api\/hr\/policy-acknowledgements$/,
  /^\/api\/hr\/notifications(\/|$)/,
  /^\/api\/hr\/requests(\/|$)/,
  /^\/api\/hr\/leave\/balances(\/|$)/,
  /^\/api\/hr\/employment-letters(\/|$)/,
  /^\/api\/hr\/staff\/[^/]+$/,
  /^\/api\/hr\/staff\/[^/]+\/documents(\/|$)/,
  /^\/api\/hr\/staff\/[^/]+\/passport-photo$/,
  /^\/api\/hr\/id-cards(\/|$)/,
  /^\/api\/hr\/engagement\/open$/,
  /^\/api\/hr\/engagement\/responses$/,
  /^\/api\/hr\/sensitive-unlock(\/|$)/,
  /^\/api\/hr\/payroll-runs\/[^/]+\/payslips\/[^/]+\/pdf$/,
  /^\/api\/hr\/executive(\/|$)/,
  /^\/api\/hr\/beneficiaries$/,
];

/** Additional paths branch managers / team HR may call without main HR workspace. */
export const HR_TEAM_API_PATTERNS = [
  /^\/api\/hr\/staff$/,
  /^\/api\/hr\/org-chart$/,
  /^\/api\/hr\/incident-memos(\/|$)/,
  /^\/api\/hr\/transfer-recommendations(\/|$)/,
  /^\/api\/hr\/leave\/calendar$/,
  /^\/api\/hr\/absence-reports(\/|$)/,
  /^\/api\/hr\/overtime-requests(\/|$)/,
  /^\/api\/hr\/attendance(\/|$)/,
  /^\/api\/hr\/feedback$/,
  /^\/api\/hr\/transfer-requests(\/|$)/,
  /^\/api\/hr\/daily-roll(\/|$)/,
  /^\/api\/hr\/departments$/,
  /^\/api\/hr\/designations$/,
  /^\/api\/hr\/discipline-cases(\/|$)/,
];

/**
 * @param {string} path
 * @param {{ teamUser?: boolean; selfUser?: boolean }} opts
 */
export function hrApiPathAllowedWithoutMainWorkspace(path, opts = {}) {
  const patterns = [...HR_SELF_SERVICE_API_PATTERNS];
  if (opts.teamUser) patterns.push(...HR_TEAM_API_PATTERNS);
  return patterns.some((p) => p.test(path));
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
