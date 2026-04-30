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
};

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

/**
 * @param {import('better-sqlite3').Database} db
 */
export function annualLeaveEntitlementDaysForUser(db, userId) {
  const policy = getHrPolicyPayload(db);
  const row = db
    .prepare(`SELECT leave_entitlement_band, job_title, base_salary_ngn FROM hr_staff_profiles WHERE user_id = ?`)
    .get(userId);
  const band = String(row?.leave_entitlement_band || '').trim().toLowerCase();
  if (band === 'junior') return policy.annualLeaveDaysJunior;
  if (band === 'senior') return policy.annualLeaveDaysSenior;
  const t = String(row?.job_title || '').toLowerCase();
  if (t.includes('intern') || t.includes('trainee') || t.includes('assistant')) return policy.annualLeaveDaysJunior;
  return policy.annualLeaveDaysSenior;
}
