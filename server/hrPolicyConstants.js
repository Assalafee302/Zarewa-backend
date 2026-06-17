/**
 * Zarewa people-policy constants (board resolution + handbook alignment).
 * @module server/hrPolicyConstants
 */

export const PROBATION_MONTHS_DEFAULT = 6;
export const TRANSFER_MIN_YEARS_BRANCH = 3;
export const TRANSFER_MIN_YEARS_INTERNAL = 2;

export const BRANCH_MANAGER_DESIGNATION_IDS = new Set([
  'desig_bm',
  'desig_actbm',
]);

export const BRANCH_TRANSFER_TYPES = new Set(['inter_branch', 'hq_to_branch', 'branch_to_hq']);

/** Leave types exposed to staff (casual retained for legacy balances). */
export const HR_LEAVE_TYPE_CATALOG = [
  { value: 'annual', label: 'Annual leave', balanceTracked: true },
  { value: 'sick', label: 'Sick leave', balanceTracked: false },
  { value: 'maternity', label: 'Maternity leave', balanceTracked: true, policyDaysKey: 'maternityLeaveDays' },
  { value: 'compassionate', label: 'Compassionate leave', balanceTracked: false },
  { value: 'unpaid', label: 'Leave without pay', balanceTracked: false, requiresGmHrApproval: true },
  { value: 'other', label: 'Other leave', balanceTracked: false },
];

/**
 * Junior L1–3; Senior L4–7 (MD uses senior annual entitlement per policy).
 * @param {number|string|null|undefined} salaryLevel
 */
export function leaveBandFromSalaryLevel(salaryLevel) {
  const n = Math.round(Number(salaryLevel) || 0);
  if (n <= 0) return '';
  if (n <= 3) return 'junior';
  return 'senior';
}

/**
 * @param {string} dateJoinedIso YYYY-MM-DD
 * @param {number} [months]
 */
export function defaultProbationEndIso(dateJoinedIso, months = PROBATION_MONTHS_DEFAULT) {
  const raw = String(dateJoinedIso || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return '';
  const d = new Date(`${raw}T12:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return '';
  d.setUTCMonth(d.getUTCMonth() + Math.max(1, Math.round(Number(months) || PROBATION_MONTHS_DEFAULT)));
  return d.toISOString().slice(0, 10);
}

function isBranchManagerRole({ designationId, jobTitle }) {
  if (designationId && BRANCH_MANAGER_DESIGNATION_IDS.has(String(designationId))) return true;
  const t = String(jobTitle || '').toLowerCase();
  return t.includes('branch manager') && !t.includes('assistant');
}

/**
 * Evaluate transfer tenure policy. Blocks unless MD/GMHR exception is recorded.
 * @param {{ transferType?: string; yearsOfService?: number; designationId?: string; jobTitle?: string }} input
 * @param {{ allowException?: boolean }} [opts]
 */
export function evaluateTransferTenurePolicy(input = {}, { allowException = false } = {}) {
  const transferType = String(input.transferType || '').trim();
  const years = Number(input.yearsOfService);
  const warnings = [];
  if (!Number.isFinite(years) || years < 0) {
    return {
      ok: allowException,
      blocked: !allowException,
      error: allowException ? undefined : 'Years of service unknown — cannot submit transfer without MD policy exception.',
      warnings: ['Years of service unknown — confirm tenure before approving transfer.'],
    };
  }
  const isBranch = BRANCH_TRANSFER_TYPES.has(transferType);
  const isBm = isBranchManagerRole(input);
  if (isBranch && years < TRANSFER_MIN_YEARS_BRANCH) {
    warnings.push(
      `Branch transfer before ${TRANSFER_MIN_YEARS_BRANCH}-year minimum (${years.toFixed(1)} yrs served). MD exception memo required.`
    );
  } else if (!isBm && !isBranch && years < TRANSFER_MIN_YEARS_INTERNAL) {
    warnings.push(
      `Internal rotation before ${TRANSFER_MIN_YEARS_INTERNAL}-year minimum (${years.toFixed(1)} yrs served). GMHR/MD exception required.`
    );
  }
  if (warnings.length && !allowException) {
    return {
      ok: false,
      blocked: true,
      error: warnings[0],
      warnings,
    };
  }
  return { ok: true, blocked: false, warnings };
}

/** Official 4-stage discipline ladder (board resolution). */
export const DISCIPLINE_PLAYBOOK_STAGES = [
  {
    stage: 1,
    title: 'Verbal warning',
    owner: 'Immediate supervisor',
    actions: 'Document the conversation; supervisor keeps a note for HR file if repeated.',
  },
  {
    stage: 2,
    title: 'Written warning / query',
    owner: 'Supervisor + HR',
    actions: 'Issue query letter; employee must respond in writing. Log as discipline case.',
  },
  {
    stage: 3,
    title: 'Final warning or suspension',
    owner: 'GMHR',
    actions: 'Final warning or suspension with dates. Payroll block may apply (MD-approved).',
  },
  {
    stage: 4,
    title: 'Demotion, transfer, or separation',
    owner: 'MD + GMHR',
    actions: 'Demotion, transfer, or termination. Separation requires reason, effective date, and MD/GMHR approval.',
  },
];

export const DISCIPLINE_PLAYBOOK_NOTES = [
  'Staff may appeal through GMHR.',
  'File tampering (removing/altering pages, backdating) is gross misconduct — immediate query.',
  'Appraisal outcomes may trigger commendation, bonus, warning, demotion, transfer, or retirement.',
  'Unsigned appraisal forms are not valid for bonus or promotion.',
  'Staff files (including discipline) retained minimum 7 years.',
];

/**
 * Staff master-file checklist for HR (confirmation, loan, ID).
 * @param {object} staff mapped staff profile
 */
export function assessStaffFileCompleteness(staff = {}) {
  const personal = staff.personal || staff.profileExtra?.personal || {};
  const nok = staff.nextOfKin || {};
  const items = [
    { id: 'name', label: 'Full name', ok: Boolean(String(staff.displayName || personal.firstName || '').trim()) },
    { id: 'dob', label: 'Date of birth', ok: Boolean(String(staff.dateOfBirthIso || personal.dateOfBirthIso || '').trim()) },
    { id: 'phone', label: 'Phone', ok: Boolean(String(staff.phone || personal.phone || '').trim()) },
    { id: 'branch', label: 'Branch / site', ok: Boolean(String(staff.branchId || '').trim()) || staff.payrollGroup === 'hq_admin' },
    { id: 'designation', label: 'Job title / designation', ok: Boolean(staff.designationId || staff.jobTitle) },
    { id: 'dateJoined', label: 'Date joined', ok: Boolean(String(staff.dateJoinedIso || '').trim()) },
    { id: 'bank', label: 'Bank details', ok: Boolean(staff.bankName && staff.bankAccountName) },
    { id: 'nok', label: 'Next of kin', ok: Boolean(nok.name && nok.phone) },
    { id: 'qualification', label: 'Highest qualification', ok: Boolean(String(staff.academicQualification || staff.minimumQualification || '').trim()) },
    { id: 'probation', label: 'Probation end (if permanent)', ok: staff.employmentType !== 'permanent' || Boolean(String(staff.probationEndIso || '').trim()) },
  ];
  const done = items.filter((i) => i.ok).length;
  return {
    items,
    complete: done === items.length,
    percent: Math.round((done / items.length) * 100),
    done,
    total: items.length,
  };
}

export function leaveTypeRequiresGmHrApproval(leaveType) {
  return String(leaveType || '').trim().toLowerCase() === 'unpaid';
}

/** Policy reference for HR UI (read-only). */
export function getHrPolicyReference() {
  return {
    probationMonthsDefault: PROBATION_MONTHS_DEFAULT,
    transferMinYearsBranch: TRANSFER_MIN_YEARS_BRANCH,
    transferMinYearsInternal: TRANSFER_MIN_YEARS_INTERNAL,
    leaveTypes: HR_LEAVE_TYPE_CATALOG,
    leaveBands: { junior: 'Levels 1–3 (14 days annual)', senior: 'Levels 4–7 (21 days annual)' },
    disciplinePlaybook: DISCIPLINE_PLAYBOOK_STAGES,
    disciplineNotes: DISCIPLINE_PLAYBOOK_NOTES,
  };
}
