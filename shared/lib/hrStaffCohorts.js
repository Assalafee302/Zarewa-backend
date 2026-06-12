/**
 * HR staff cohorts — branch employees vs scholarship, domestic, HQ, and mining.
 * Keep frontend copy in sync (src/shared/hrStaffCohorts.js).
 */

export const HR_PAYROLL_GROUPS = {
  BRANCH_OPS: 'branch_ops',
  MINING: 'mining_div',
  HQ_ADMIN: 'hq_admin',
  SCHOLARSHIP: 'scholarship',
  DOMESTIC: 'chairman_staffs',
};

/** Listed in the main Employees directory (branch operations). */
export const EMPLOYEE_DIRECTORY_GROUPS = [HR_PAYROLL_GROUPS.BRANCH_OPS];

export const SCHOLARSHIP_GROUPS = [HR_PAYROLL_GROUPS.SCHOLARSHIP];

export const DOMESTIC_GROUPS = [HR_PAYROLL_GROUPS.DOMESTIC];

export const HQ_SPECIAL_GROUPS = [HR_PAYROLL_GROUPS.MINING, HR_PAYROLL_GROUPS.HQ_ADMIN];

/** Not tied to a branch; excluded from daily attendance roll. */
export const NON_BRANCH_PAYROLL_GROUPS = [
  HR_PAYROLL_GROUPS.MINING,
  HR_PAYROLL_GROUPS.HQ_ADMIN,
  HR_PAYROLL_GROUPS.SCHOLARSHIP,
  HR_PAYROLL_GROUPS.DOMESTIC,
];

export const ATTENDANCE_EXEMPT_PAYROLL_GROUPS = [...NON_BRANCH_PAYROLL_GROUPS];

export const PAYROLL_GROUP_LABELS = {
  [HR_PAYROLL_GROUPS.BRANCH_OPS]: 'Branch staff',
  [HR_PAYROLL_GROUPS.MINING]: 'Mining division',
  [HR_PAYROLL_GROUPS.HQ_ADMIN]: 'HQ administrative',
  [HR_PAYROLL_GROUPS.SCHOLARSHIP]: 'Scholarship beneficiary',
  [HR_PAYROLL_GROUPS.DOMESTIC]: 'Domestic staff',
};

/** @param {string | null | undefined} payrollGroup */
export function normalizePayrollGroup(payrollGroup) {
  const g = String(payrollGroup || HR_PAYROLL_GROUPS.BRANCH_OPS).trim();
  return g || HR_PAYROLL_GROUPS.BRANCH_OPS;
}

/** @param {string | null | undefined} payrollGroup */
export function isBranchEmployee(payrollGroup) {
  return normalizePayrollGroup(payrollGroup) === HR_PAYROLL_GROUPS.BRANCH_OPS;
}

/** @param {string | null | undefined} payrollGroup */
export function requiresAttendance(payrollGroup) {
  return isBranchEmployee(payrollGroup);
}

/** @param {string | null | undefined} payrollGroup */
export function isNonBranchStaff(payrollGroup) {
  return NON_BRANCH_PAYROLL_GROUPS.includes(normalizePayrollGroup(payrollGroup));
}

/** @param {string | null | undefined} payrollGroup */
export function isScholarshipBeneficiary(payrollGroup) {
  return normalizePayrollGroup(payrollGroup) === HR_PAYROLL_GROUPS.SCHOLARSHIP;
}

/** @param {string | null | undefined} payrollGroup */
export function isDomesticStaff(payrollGroup) {
  return normalizePayrollGroup(payrollGroup) === HR_PAYROLL_GROUPS.DOMESTIC;
}

/** HQ monthly payroll runs — branch operations staff only (not scholarship, mining, domestic, etc.). */
export function isPayrollRunEligible(payrollGroup) {
  return isBranchEmployee(payrollGroup);
}

/** PAYE applies only to branch staff. */
export function requiresPaye(payrollGroup) {
  return isBranchEmployee(payrollGroup);
}

/** Employee pension deduction applies only to branch staff. */
export function requiresEmployeePensionDeduction(payrollGroup) {
  return isBranchEmployee(payrollGroup);
}

/** Employer pension contribution applies only to branch staff. */
export function requiresEmployerPensionContribution(payrollGroup) {
  return isBranchEmployee(payrollGroup);
}

/** @param {string | object | null | undefined} extra */
function parseProfileExtra(extra) {
  if (!extra) return {};
  if (typeof extra === 'object') return extra;
  try {
    return JSON.parse(String(extra));
  } catch {
    return {};
  }
}

/**
 * Contributory pension on branch payroll unless explicitly exempt on the staff profile.
 * @param {{ payrollGroup?: string | null, profileExtraJson?: string | object | null, profileExtra?: object | null }} staff
 */
export function staffMeetsPensionPolicy(staff) {
  if (!requiresEmployeePensionDeduction(staff?.payrollGroup)) return false;
  const extra = parseProfileExtra(staff?.profileExtraJson ?? staff?.profileExtra);
  if (extra?.statutory?.pensionExempt === true) return false;
  return true;
}

/**
 * Domestic staff and other non-branch cohorts are exempt from statutory payroll deductions
 * (PAYE, pension, attendance penalties on payroll).
 */
export function isStatutoryPayrollExempt(payrollGroup) {
  return !isBranchEmployee(payrollGroup);
}

/** Paid via Executive benefits (monthly stipend / domestic salary), not HQ payroll runs. */
export function usesExecutiveBenefitsMonthlyPay(payrollGroup) {
  const g = normalizePayrollGroup(payrollGroup);
  return g === HR_PAYROLL_GROUPS.SCHOLARSHIP || g === HR_PAYROLL_GROUPS.DOMESTIC;
}

/** @param {string | null | undefined} payrollGroup */
export function payrollGroupLabel(payrollGroup) {
  return PAYROLL_GROUP_LABELS[normalizePayrollGroup(payrollGroup)] || String(payrollGroup || 'Staff');
}

/**
 * @param {'employees' | 'scholarship' | 'domestic' | 'hq_special' | 'all'} cohort
 * @returns {string[] | null} payroll groups to include, or null for all
 */
export function payrollGroupsForCohort(cohort) {
  const c = String(cohort || 'employees').trim().toLowerCase();
  if (c === 'all') return null;
  if (c === 'scholarship') return [...SCHOLARSHIP_GROUPS];
  if (c === 'domestic') return [...DOMESTIC_GROUPS];
  if (c === 'hq_special' || c === 'hq-special') return [...HQ_SPECIAL_GROUPS];
  return [...EMPLOYEE_DIRECTORY_GROUPS];
}
