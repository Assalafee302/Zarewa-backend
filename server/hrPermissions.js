/**
 * Canonical HR permission keys and capability helpers for Zarewa ERP.
 * @module server/hrPermissions
 */

import { userHasPermission, permissionsForRole } from './auth.js';
import {
  isDomesticStaff,
  isScholarshipBeneficiary,
} from '../shared/lib/hrStaffCohorts.js';

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
function userEffectivePermissionList(user) {
  if (Array.isArray(user?.permissions) && user.permissions.length) return user.permissions;
  return permissionsForRole(user?.roleKey);
}

/**
 * @param {object | null | undefined} user
 * @param {string} permission
 */
export function hrUserHas(user, permission) {
  if (!permission) return false;
  if (userHasPermission(user, '*')) return true;
  if (userHasPermission(user, permission)) return true;
  const perm = String(permission).trim();
  if (perm.endsWith('.*')) {
    const prefix = perm.slice(0, -1);
    return userEffectivePermissionList(user).some(
      (p) => p === '*' || String(p).startsWith(prefix)
    );
  }
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

/** Company-wide pension rates — HR Executive / settings admin only. */
export function userCanEditPensionPolicyRates(user) {
  if (hrUserHas(user, '*')) return true;
  return (
    hrUserHas(user, 'hr.executive.benefits.manage') ||
    hrUserHas(user, 'hr.chairman.manage') ||
    hrUserHas(user, 'hr.payroll.md_approve') ||
    hrUserHas(user, 'hr.settings.manage')
  );
}

/** API paths self-service staff may call without main HR workspace. */
export const HR_SELF_SERVICE_API_PATTERNS = [
  /^\/api\/hr\/health$/,
  /^\/health$/,
  /^\/api\/hr\/notification-summary$/,
  /^\/notification-summary$/,
  /^\/api\/hr\/my(\/|$)/,
  /^\/my(\/|$)/,
  /^\/api\/hr\/team(\/|$)/,
  /^\/team(\/|$)/,
  /^\/api\/hr\/me(\/|$)/,
  /^\/me(\/|$)/,
  /^\/api\/hr\/policy-requirements$/,
  /^\/policy-requirements$/,
  /^\/api\/hr\/policy-acknowledgements$/,
  /^\/policy-acknowledgements$/,
  /^\/api\/hr\/notifications(\/|$)/,
  /^\/notifications(\/|$)/,
  /^\/api\/hr\/requests(\/|$)/,
  /^\/requests(\/|$)/,
  /^\/api\/hr\/leave\/balances(\/|$)/,
  /^\/leave\/balances(\/|$)/,
  /^\/api\/hr\/leave\/calendar$/,
  /^\/leave\/calendar$/,
  /^\/api\/hr\/employment-letters(\/|$)/,
  /^\/employment-letters(\/|$)/,
  /^\/api\/hr\/staff\/[^/]+$/,
  /^\/staff\/[^/]+$/,
  /^\/api\/hr\/staff\/[^/]+\/documents(\/|$)/,
  /^\/staff\/[^/]+\/documents(\/|$)/,
  /^\/api\/hr\/staff\/[^/]+\/passport-photo$/,
  /^\/staff\/[^/]+\/passport-photo$/,
  /^\/api\/hr\/staff\/[^/]+\/loan-schedule$/,
  /^\/staff\/[^/]+\/loan-schedule$/,
  /^\/api\/hr\/id-cards(\/|$)/,
  /^\/id-cards(\/|$)/,
  /^\/api\/hr\/engagement\/open$/,
  /^\/engagement\/open$/,
  /^\/api\/hr\/engagement\/responses$/,
  /^\/engagement\/responses$/,
  /^\/api\/hr\/sensitive(\/|$)/,
  /^\/sensitive(\/|$)/,
  /^\/api\/hr\/sensitive-unlock(\/|$)/,
  /^\/sensitive-unlock(\/|$)/,
  /^\/api\/hr\/payroll-runs\/[^/]+\/payslips\/[^/]+\/pdf$/,
  /^\/payroll-runs\/[^/]+\/payslips\/[^/]+\/pdf$/,
  /^\/api\/hr\/payslips(\/|$)/,
  /^\/payslips(\/|$)/,
  /^\/api\/hr\/templates\/guarantor-form$/,
  /^\/templates\/guarantor-form$/,
  /^\/api\/hr\/executive(\/|$)/,
  /^\/executive(\/|$)/,
  /^\/api\/hr\/chairman(\/|$)/,
  /^\/chairman(\/|$)/,
  /^\/api\/hr\/beneficiaries$/,
  /^\/beneficiaries$/,
];

/** Executive benefits leaders — scholarship registers, domestic staff, payments (without full branch HR). */
export const HR_EXECUTIVE_SCHOLARSHIP_DOMESTIC_API_PATTERNS = [
  /^\/api\/hr\/staff$/,
  /^\/staff$/,
  /^\/api\/hr\/staff\/register$/,
  /^\/staff\/register$/,
  /^\/api\/hr\/staff\/[^/]+$/,
  /^\/staff\/[^/]+$/,
  /^\/api\/hr\/staff\/[^/]+\/documents(\/|$)/,
  /^\/staff\/[^/]+\/documents(\/|$)/,
  /^\/api\/hr\/staff\/[^/]+\/passport-photo$/,
  /^\/staff\/[^/]+\/passport-photo$/,
  /^\/api\/hr\/staff\/[^/]+\/audit-events$/,
  /^\/staff\/[^/]+\/audit-events$/,
  /^\/api\/hr\/departments$/,
  /^\/departments$/,
  /^\/api\/hr\/designations$/,
  /^\/designations$/,
  /^\/api\/hr\/requests(\/|$)/,
  /^\/requests(\/|$)/,
  /^\/api\/hr\/reports(\/|$)/,
  /^\/reports(\/|$)/,
  /^\/api\/hr\/executive(\/|$)/,
  /^\/executive(\/|$)/,
  /^\/api\/hr\/chairman(\/|$)/,
  /^\/chairman(\/|$)/,
  /^\/api\/hr\/beneficiaries$/,
  /^\/beneficiaries$/,
];

/** Additional paths branch managers / team HR may call without main HR workspace. */
export const HR_TEAM_API_PATTERNS = [
  /^\/api\/hr\/staff$/,
  /^\/staff$/,
  /^\/api\/hr\/org-chart$/,
  /^\/org-chart$/,
  /^\/api\/hr\/incident-memos(\/|$)/,
  /^\/incident-memos(\/|$)/,
  /^\/api\/hr\/transfer-recommendations(\/|$)/,
  /^\/transfer-recommendations(\/|$)/,
  /^\/api\/hr\/leave\/calendar$/,
  /^\/leave\/calendar$/,
  /^\/api\/hr\/absence-reports(\/|$)/,
  /^\/absence-reports(\/|$)/,
  /^\/api\/hr\/attendance(\/|$)/,
  /^\/attendance(\/|$)/,
  /^\/api\/hr\/feedback$/,
  /^\/feedback$/,
  /^\/api\/hr\/transfer-requests(\/|$)/,
  /^\/transfer-requests(\/|$)/,
  /^\/api\/hr\/daily-roll(\/|$)/,
  /^\/daily-roll(\/|$)/,
  /^\/api\/hr\/departments$/,
  /^\/departments$/,
  /^\/api\/hr\/designations$/,
  /^\/designations$/,
  /^\/api\/hr\/discipline-cases(\/|$)/,
  /^\/discipline-cases(\/|$)/,
];

/**
 * Normalized `/api/hr/*` path for workspace allowlist checks (Express mount-safe).
 * @param {import('express').Request} req
 */
export function hrApiPathForRequest(req) {
  const base = String(req.baseUrl || '').trim();
  const path = String(req.path || '').trim();
  if (base && path) {
    return `${base}${path.startsWith('/') ? path : `/${path}`}`;
  }
  return path || String(req.originalUrl || '').split('?')[0];
}

/**
 * @param {object | null | undefined} user
 */
export function userHasHrSelfServiceOnly(user) {
  if (!user) return false;
  if (hrUserHas(user, '*')) return false;
  if (userCanAccessHrModule(user) || userCanAccessTeamHr(user)) return false;
  return hrUserHas(user, 'hr.self') || hrUserHas(user, 'hr.my_profile.view');
}

/**
 * @param {string} path
 * @param {{ teamUser?: boolean; selfUser?: boolean; executiveScholarshipDomesticUser?: boolean }} opts
 */
export function hrApiPathAllowedWithoutMainWorkspace(path, opts = {}) {
  const patterns = [...HR_SELF_SERVICE_API_PATTERNS];
  if (opts.teamUser) patterns.push(...HR_TEAM_API_PATTERNS);
  if (opts.executiveScholarshipDomesticUser) {
    patterns.push(...HR_EXECUTIVE_SCHOLARSHIP_DOMESTIC_API_PATTERNS);
  }
  return patterns.some((p) => p.test(path));
}

/** @param {string | null | undefined} payrollGroup */
export function isScholarshipOrDomesticPayrollGroup(payrollGroup) {
  return isScholarshipBeneficiary(payrollGroup) || isDomesticStaff(payrollGroup);
}

/** View scholarship / domestic registers and executive benefits. */
export function userCanViewScholarshipDomesticRegisters(user) {
  if (hrUserHas(user, '*')) return true;
  if (userCanViewExecutiveBenefits(user)) return true;
  return hrUserHas(user, 'hr.directory.view') || hrUserHas(user, 'hr.staff.manage');
}

/** Manage scholarship / domestic staff files and executive benefits payments. */
export function userCanManageScholarshipDomesticRegisters(user) {
  if (hrUserHas(user, '*')) return true;
  if (userCanManageExecutiveBenefits(user)) return true;
  return hrUserHas(user, 'hr.staff.manage');
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 */
export function staffUserIsScholarshipOrDomestic(db, userId) {
  const uid = String(userId || '').trim();
  if (!uid) return false;
  try {
    const row = db.prepare(`SELECT payroll_group FROM hr_staff_profiles WHERE user_id = ?`).get(uid);
    return isScholarshipOrDomesticPayrollGroup(row?.payroll_group);
  } catch {
    return false;
  }
}

/** CEO / Chairman — scholarship registers, domestic staff, executive benefits (may omit full branch HR). */
export function userCanAccessScholarshipDomesticExecutive(user) {
  if (hrUserHas(user, '*')) return true;
  if (!userCanViewExecutiveBenefits(user)) return false;
  return (
    hrUserHas(user, 'hr.chairman.manage') ||
    hrUserHas(user, 'hr.executive.benefits.manage') ||
    hrUserHas(user, 'hr.directory.view') ||
    hrUserHas(user, 'hr.staff.manage')
  );
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
