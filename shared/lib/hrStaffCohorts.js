/**
 * HR staff cohorts — branch employees vs scholarship, domestic, HQ, and mining.
 * Frontend copies via `npm run sync:shared` → src/shared/hrStaffCohorts.js
 */

export const HR_PAYROLL_GROUPS = {
  BRANCH_OPS: 'branch_ops',
  MINING: 'mining_div',
  HQ_ADMIN: 'hq_admin',
  SCHOLARSHIP: 'scholarship',
  DOMESTIC: 'chairman_staffs',
};

/** Listed in the main Employees directory (ERP logins: branch, HQ, and mining). */
export const EMPLOYEE_DIRECTORY_GROUPS = [
  HR_PAYROLL_GROUPS.BRANCH_OPS,
  HR_PAYROLL_GROUPS.HQ_ADMIN,
  HR_PAYROLL_GROUPS.MINING,
];

export const SCHOLARSHIP_GROUPS = [HR_PAYROLL_GROUPS.SCHOLARSHIP];

export const DOMESTIC_GROUPS = [HR_PAYROLL_GROUPS.DOMESTIC];

/** Executive family and household staff — HR records only; no ERP login. */
export const BENEFICIARY_ONLY_PAYROLL_GROUPS = [
  HR_PAYROLL_GROUPS.SCHOLARSHIP,
  HR_PAYROLL_GROUPS.DOMESTIC,
];

/** Mining staff may log in but are limited to HR portal (no sales/finance/operations). */
export const ERP_ACCESS_RESTRICTED_PAYROLL_GROUPS = [HR_PAYROLL_GROUPS.MINING];

/**
 * Not eligible as refund claiming / sales-staff payout recipients.
 * Chairman household, scholarship beneficiaries, and mining stay off the refund staff picker.
 */
export const REFUND_CLAIMING_EXCLUDED_PAYROLL_GROUPS = [
  HR_PAYROLL_GROUPS.DOMESTIC,
  HR_PAYROLL_GROUPS.SCHOLARSHIP,
  HR_PAYROLL_GROUPS.MINING,
];

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
  [HR_PAYROLL_GROUPS.SCHOLARSHIP]: 'Executive family',
  [HR_PAYROLL_GROUPS.DOMESTIC]: 'Household staff',
};

/** @param {string | null | undefined} payrollGroup */
export function normalizePayrollGroup(payrollGroup) {
  const g = String(payrollGroup || HR_PAYROLL_GROUPS.BRANCH_OPS).trim().toLowerCase();
  if (!g) return HR_PAYROLL_GROUPS.BRANCH_OPS;
  if (g === 'scholaship' || g === 'scholarship_beneficiary') return HR_PAYROLL_GROUPS.SCHOLARSHIP;
  if (g === 'chairman_staff' || g === 'domestic' || g === 'domestic_staff') return HR_PAYROLL_GROUPS.DOMESTIC;
  if (g === 'mining' || g === 'mining_staff') return HR_PAYROLL_GROUPS.MINING;
  return g;
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

/** @param {string | null | undefined} payrollGroup */
export function isBeneficiaryOnlyPayrollGroup(payrollGroup) {
  return BENEFICIARY_ONLY_PAYROLL_GROUPS.includes(normalizePayrollGroup(payrollGroup));
}

/** Branch, HQ, and mining employees may have app logins; beneficiaries may not. */
export function payrollGroupMayHaveLogin(payrollGroup) {
  return !isBeneficiaryOnlyPayrollGroup(payrollGroup);
}

/** Mining staff must not receive ERP operational roles. */
export function isErpAccessRestrictedPayrollGroup(payrollGroup) {
  return ERP_ACCESS_RESTRICTED_PAYROLL_GROUPS.includes(normalizePayrollGroup(payrollGroup));
}

/** Branch / HQ admin may appear on refund claiming-staff lists; chairman, scholarship, mining may not. */
export function isRefundClaimingStaffEligiblePayrollGroup(payrollGroup) {
  return !REFUND_CLAIMING_EXCLUDED_PAYROLL_GROUPS.includes(normalizePayrollGroup(payrollGroup));
}

/** Included in HQ monthly payroll runs (not scholarship or domestic — those use Executive benefits). */
export const PAYROLL_RUN_ELIGIBLE_GROUPS = [
  HR_PAYROLL_GROUPS.BRANCH_OPS,
  HR_PAYROLL_GROUPS.HQ_ADMIN,
  HR_PAYROLL_GROUPS.MINING,
];

/** HQ monthly payroll runs — branch, HQ admin, and mining staff. */
export function isPayrollRunEligible(payrollGroup) {
  return PAYROLL_RUN_ELIGIBLE_GROUPS.includes(normalizePayrollGroup(payrollGroup));
}

/** PAYE applies to HQ payroll-run staff (manual fixed amount per profile). */
export function requiresPaye(payrollGroup) {
  return isPayrollRunEligible(payrollGroup);
}

/** Employee pension deduction applies to HQ payroll-run staff. */
export function requiresEmployeePensionDeduction(payrollGroup) {
  return isPayrollRunEligible(payrollGroup);
}

/** Employer pension contribution applies to HQ payroll-run staff. */
export function requiresEmployerPensionContribution(payrollGroup) {
  return isPayrollRunEligible(payrollGroup);
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
  return !isPayrollRunEligible(payrollGroup);
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

/** Kaduna (HQ) — default cashier branch for HQ and mining when profile branch is unset. */
export const HQ_CASHIER_BRANCH_ID = 'BR-KD';

/**
 * Branch whose cashier pays approved loans and receives cash/bank repayments.
 * Domestic staff use their host branch when set; HQ and mining default to Kaduna (HQ).
 * @param {{ branchId?: string | null; branch_id?: string | null; payrollGroup?: string | null; payroll_group?: string | null } | null | undefined} profile
 * @param {string} [fallbackBranchId]
 */
export function resolveStaffCashierBranchId(profile, fallbackBranchId = HQ_CASHIER_BRANCH_ID) {
  const explicit = String(profile?.branchId ?? profile?.branch_id ?? '').trim();
  if (explicit) return explicit;
  const payrollGroup = normalizePayrollGroup(profile?.payrollGroup ?? profile?.payroll_group);
  if (
    payrollGroup === HR_PAYROLL_GROUPS.HQ_ADMIN ||
    payrollGroup === HR_PAYROLL_GROUPS.MINING ||
    payrollGroup === HR_PAYROLL_GROUPS.DOMESTIC
  ) {
    return String(fallbackBranchId || HQ_CASHIER_BRANCH_ID).trim() || HQ_CASHIER_BRANCH_ID;
  }
  return String(fallbackBranchId || HQ_CASHIER_BRANCH_ID).trim() || HQ_CASHIER_BRANCH_ID;
}
