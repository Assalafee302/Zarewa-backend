/**
 * Central HR handbook-style rules (loaded from hr_policy_config with defaults).
 * @param {import('better-sqlite3').Database} db
 */

const DEFAULT_POLICY = {
  loanMinServiceYears: 3,
  loanMaxSalaryMonths: 4,
  loanMaxRepaymentMonths: 12,
  maxConcurrentBranchLoans: 5,
  annualLeaveDaysSenior: 21,
  annualLeaveDaysJunior: 14,
  casualLeaveDaysPerYear: 7,
  maternityLeaveDays: 60,
  itfRateEmployer: 0.01, // 1% of gross payroll — employer pays to ITF
  nsitfRateEmployer: 0.01, // 1% of gross payroll — employer pays to NSITF
  halfMonthBonusRate: 0.5, // 50% of monthly base salary (December year-end bonus)
  pensionEmployeePercent: 8, // employee pension deduction (% of gross)
  pensionEmployerPercent: 10, // employer pension contribution (% of gross, not deducted from net)
};

const POLICY_PATCH_KEYS = new Set([
  'loanMinServiceYears',
  'loanMaxSalaryMonths',
  'loanMaxRepaymentMonths',
  'maxConcurrentBranchLoans',
  'annualLeaveDaysSenior',
  'annualLeaveDaysJunior',
  'casualLeaveDaysPerYear',
  'maternityLeaveDays',
  'itfRateEmployer',
  'nsitfRateEmployer',
  'halfMonthBonusRate',
  'pensionEmployeePercent',
  'pensionEmployerPercent',
]);

export function getHrPolicyPayload(db) {
  try {
    const row = db
      .prepare(`SELECT payload_json FROM hr_policy_config ORDER BY effective_from_iso DESC LIMIT 1`)
      .get();
    if (!row?.payload_json) return { ...DEFAULT_POLICY };
    const parsed = JSON.parse(String(row.payload_json));
    return { ...DEFAULT_POLICY, ...parsed };
  } catch {
    return { ...DEFAULT_POLICY };
  }
}

/**
 * Persist HR policy updates (inserts a new effective-dated row).
 * @param {import('better-sqlite3').Database} db
 * @param {Record<string, unknown>} patch
 */
export function updateHrPolicyPayload(db, patch = {}) {
  const current = getHrPolicyPayload(db);
  const next = { ...current };
  for (const [key, raw] of Object.entries(patch || {})) {
    if (!POLICY_PATCH_KEYS.has(key)) continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) {
      return { ok: false, error: `Invalid value for ${key}.` };
    }
    if (key.includes('Percent') && n > 100) {
      return { ok: false, error: `${key} cannot exceed 100%.` };
    }
    if (key.includes('Rate') && n > 2) {
      return { ok: false, error: `${key} is out of range.` };
    }
    next[key] = n;
  }
  try {
    const id = `HRPOL-${Date.now().toString(36)}`;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO hr_policy_config (id, effective_from_iso, payload_json, created_at_iso) VALUES (?,?,?,?)`
    ).run(id, now.slice(0, 10), JSON.stringify(next), now);
    return { ok: true, policy: next };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

export function serviceYearsFromJoinedIso(dateJoinedIso) {
  const d = String(dateJoinedIso || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return 0;
  const start = new Date(`${d}T12:00:00Z`);
  const now = new Date();
  const diffMs = now.getTime() - start.getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return 0;
  return diffMs / (365.25 * 24 * 60 * 60 * 1000);
}

function monthlyGrossFromProfile(prof) {
  const base = Math.round(Number(prof?.base_salary_ngn) || 0);
  const h = Math.round(Number(prof?.housing_allowance_ngn) || 0);
  const t = Math.round(Number(prof?.transport_allowance_ngn) || 0);
  return base + h + t;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} branchId
 */
export function countActiveApprovedLoansInBranch(db, branchId) {
  const bid = String(branchId || '').trim();
  if (!bid) return 0;
  const rows = db
    .prepare(
      `SELECT r.id, r.payload_json FROM hr_requests r
       JOIN hr_staff_profiles p ON p.user_id = r.user_id
       WHERE r.kind = 'loan' AND r.status = 'approved' AND p.branch_id = ?`
    )
    .all(bid);
  let n = 0;
  for (const row of rows) {
    try {
      const p = JSON.parse(String(row.payload_json || '{}'));
      const active =
        p.deductionsActive !== false &&
        (!p.loanRepaidByScheduleAtIso || !p.loanRepaidByPrincipalAtIso) &&
        (p.principalOutstandingNgn == null || Number(p.principalOutstandingNgn) > 0);
      if (active) n += 1;
    } catch {
      n += 1;
    }
  }
  return n;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 * @param {{ amountNgn: number; repaymentMonths: number }} loan
 * @returns {{ ok: boolean; error?: string; policy?: object }}
 */
export function validateStaffLoanApplication(db, userId, loan) {
  const policy = getHrPolicyPayload(db);
  const prof = db
    .prepare(
      `SELECT base_salary_ngn, housing_allowance_ngn, transport_allowance_ngn,
              date_joined_iso, branch_id
       FROM hr_staff_profiles WHERE user_id = ?`
    )
    .get(userId);
  if (!prof) return { ok: false, error: 'No HR staff profile for this user.' };

  const years = serviceYearsFromJoinedIso(prof.date_joined_iso);
  if (years < policy.loanMinServiceYears) {
    return {
      ok: false,
      error: `Loan requires at least ${policy.loanMinServiceYears} years of service (current approx. ${years.toFixed(2)}).`,
      policy,
    };
  }

  const gross = monthlyGrossFromProfile(prof);
  const maxBySalary = Math.round(gross * policy.loanMaxSalaryMonths);
  const amountNgn = Math.round(Number(loan.amountNgn) || 0);
  if (gross > 0 && amountNgn > maxBySalary) {
    return {
      ok: false,
      error: `Loan exceeds maximum of ${policy.loanMaxSalaryMonths} months' gross salary (cap ≈ ₦${maxBySalary.toLocaleString()}).`,
      policy,
    };
  }

  const months = Math.round(Number(loan.repaymentMonths) || 0);
  if (months < 1 || months > policy.loanMaxRepaymentMonths) {
    return {
      ok: false,
      error: `Repayment must be between 1 and ${policy.loanMaxRepaymentMonths} months.`,
      policy,
    };
  }

  const concurrent = countActiveApprovedLoansInBranch(db, prof.branch_id);
  if (concurrent >= policy.maxConcurrentBranchLoans) {
    return {
      ok: false,
      error: `This branch already has ${policy.maxConcurrentBranchLoans} active staff loans (policy limit).`,
      policy,
    };
  }

  return { ok: true, policy };
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function listHolidayDaySet(db, scope = 'NG') {
  const rows = db.prepare(`SELECT day_iso FROM hr_public_holidays WHERE scope = ?`).all(String(scope || 'NG'));
  return new Set(rows.map((r) => String(r.day_iso).slice(0, 10)));
}

function parseIsoDay(iso) {
  const s = String(iso || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return new Date(`${s}T12:00:00Z`);
}

/**
 * Working days between start and end inclusive (Mon–Fri), excluding public holidays.
 * @param {import('better-sqlite3').Database} db
 */
export function countWorkingDaysInclusive(db, startIso, endIso, holidayScope = 'NG') {
  const holidays = listHolidayDaySet(db, holidayScope);
  const a = parseIsoDay(startIso);
  const b = parseIsoDay(endIso);
  if (!a || !b) return 0;
  let x = Math.min(a.getTime(), b.getTime());
  const end = Math.max(a.getTime(), b.getTime());
  let n = 0;
  while (x <= end) {
    const d = new Date(x);
    const wd = d.getUTCDay();
    const ds = d.toISOString().slice(0, 10);
    if (wd !== 0 && wd !== 6 && !holidays.has(ds)) n += 1;
    x += 24 * 60 * 60 * 1000;
  }
  return n;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 * @param {string} dayIso YYYY-MM-DD
 */
export function isApprovedLeaveOnDay(db, userId, dayIso) {
  const day = String(dayIso || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const rows = db
    .prepare(
      `SELECT l.start_date_iso, l.end_date_iso, l.leave_type
       FROM hr_request_leave l
       JOIN hr_requests r ON r.id = l.request_id
       WHERE r.user_id = ? AND r.kind = 'leave' AND r.status = 'approved'`
    )
    .all(userId);
  const t = new Date(`${day}T12:00:00Z`).getTime();
  for (const row of rows) {
    const s = parseIsoDay(row.start_date_iso);
    const e = parseIsoDay(row.end_date_iso);
    if (!s || !e) continue;
    const ts = Math.min(s.getTime(), e.getTime());
    const te = Math.max(s.getTime(), e.getTime());
    if (t >= ts && t <= te) return { onLeave: true, leaveType: row.leave_type };
  }
  return { onLeave: false, leaveType: null };
}

export const WORKING_HOURS_CONFIG = {
  weekdayStartHour: 8,      // 8:00 AM
  weekdayEndHour: 17,       // 5:00 PM
  weekdayOvertimeAfterHours: 9,  // overtime after 9 hrs Mon-Fri
  saturdayStartHour: 9,     // 9:00 AM
  saturdayEndHour: 16,      // 4:00 PM
  saturdayOvertimeAfterHours: 7, // overtime after 7 hrs Saturday
  workDays: [1, 2, 3, 4, 5, 6], // Mon=1 through Sat=6 (0=Sun)
  lunchBreakMinutes: 60,
  salaryPaymentDay: 25,     // 25th of each month
};

/**
 * Calculates severance entitlement per the Zarewa employee handbook.
 * @param {number} yearsOfService
 * @param {number} annualSalaryNgn  (base_salary_ngn * 12)
 * @returns {{ pensionOnly: boolean, bonusYears: number, severanceNgn: number, description: string }}
 */
export function calculateSeveranceEntitlement(yearsOfService, annualSalaryNgn) {
  const yrs = Math.max(0, Math.floor(Number(yearsOfService) || 0));
  const annual = Math.max(0, Number(annualSalaryNgn) || 0);
  let bonusYears = 0;
  let description = '';
  if (yrs < 1) { return { pensionOnly: true, bonusYears: 0, severanceNgn: 0, description: 'Less than 1 year — no severance' }; }
  if (yrs <= 5)  { bonusYears = 0; description = 'Contributory pension only (1–5 years)'; }
  else if (yrs <= 10) { bonusYears = 1;   description = 'Pension + 1 year salary (6–10 years)'; }
  else if (yrs <= 15) { bonusYears = 1.5; description = 'Pension + 1.5 years salary (11–15 years)'; }
  else if (yrs <= 20) { bonusYears = 2;   description = 'Pension + 2 years salary (16–20 years)'; }
  else if (yrs <= 30) { bonusYears = 2.5; description = 'Pension + 2.5 years salary (21–30 years)'; }
  else                { bonusYears = 3;   description = 'Pension + 3 years salary (31+ years)'; }
  return { pensionOnly: bonusYears === 0, bonusYears, severanceNgn: bonusYears * annual, description };
}

export function validateLeaveEligibility(leaveType, probationEndIso) {
  if (!leaveType) return { ok: false, error: 'Leave type is required.' };
  const now = new Date();
  const probationEnd = probationEndIso ? new Date(probationEndIso) : null;
  const onProbation = probationEnd && probationEnd > now;
  if (String(leaveType).toLowerCase() === 'casual' && onProbation) {
    return { ok: false, error: `Casual leave is not available during probation. Probation ends ${probationEndIso}.` };
  }
  return { ok: true };
}

/** Map UI band labels to backend junior/senior buckets. */
export function normalizeLeaveEntitlementBand(band) {
  const b = String(band || '').trim().toLowerCase();
  if (!b) return '';
  if (b === 'standard' || b === 'junior') return 'junior';
  if (b === 'senior' || b === 'executive') return 'senior';
  return b;
}

function currentPeriodYyyymm() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/**
 * Validate leave create/submit (probation, balance for annual/casual).
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 * @param {{ leaveType?: string; daysRequested?: number }} payload
 */
export function validateLeaveRequest(db, userId, payload) {
  if (!db || !userId) return { ok: false, error: 'Invalid leave request.' };
  const leaveType = String(payload?.leaveType || '').trim().toLowerCase();
  const daysRequested = Math.round(Number(payload?.daysRequested) || 0);
  const prof = db.prepare(`SELECT probation_end_iso FROM hr_staff_profiles WHERE user_id = ?`).get(userId);
  const elig = validateLeaveEligibility(leaveType, prof?.probation_end_iso);
  if (!elig.ok) return elig;
  if (daysRequested <= 0) return { ok: false, error: 'Leave days must be greater than 0.' };

  if (['annual', 'casual'].includes(leaveType)) {
    const period = currentPeriodYyyymm();
    const bal = db
      .prepare(
        `SELECT closing_days FROM hr_leave_balances WHERE user_id = ? AND leave_type = ? AND period_yyyymm = ?`
      )
      .get(userId, leaveType, period);
    const available = Number(bal?.closing_days ?? 0);
    if (daysRequested > available) {
      return {
        ok: false,
        error: `Insufficient ${leaveType} leave balance (${available} day(s) available, ${daysRequested} requested).`,
      };
    }
  }
  return { ok: true };
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function annualLeaveEntitlementDaysForUser(db, userId) {
  const policy = getHrPolicyPayload(db);
  const row = db
    .prepare(`SELECT leave_entitlement_band, job_title, base_salary_ngn FROM hr_staff_profiles WHERE user_id = ?`)
    .get(userId);
  const band = normalizeLeaveEntitlementBand(row?.leave_entitlement_band || '');
  if (band === 'junior') return policy.annualLeaveDaysJunior;
  if (band === 'senior') return policy.annualLeaveDaysSenior;
  const t = String(row?.job_title || '').toLowerCase();
  if (t.includes('intern') || t.includes('trainee') || t.includes('assistant')) return policy.annualLeaveDaysJunior;
  return policy.annualLeaveDaysSenior;
}
