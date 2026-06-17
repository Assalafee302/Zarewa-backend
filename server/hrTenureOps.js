/**
 * Tenure, service-years gates, and pay-step suggestions for HR org model.
 * @module server/hrTenureOps
 */

import { serviceYearsFromJoinedIso } from './hrBusinessRules.js';
import { ACTING_DESIGNATION_IDS, DESIGNATION_OFFICE_KEYS } from './hrOrgConstants.js';
import { getHrDesignation } from './hrMasterData.js';
import { userHasPermission } from './auth.js';

export const ACTING_APPOINTMENT_MAX_MONTHS = 6;
export const TITLE_TIERS = [
  'trainee',
  'assistant',
  'officer',
  'supervisor',
  'deputy',
  'manager',
  'executive',
  'acting',
];

const DEFAULT_MIN_YEARS_BY_TIER = {
  trainee: 0,
  assistant: 0,
  officer: 1,
  supervisor: 2,
  deputy: 3,
  manager: 3,
  executive: 5,
  acting: 3,
};

export function roundTenureYears(years) {
  return Math.floor(Math.max(0, Number(years) || 0) * 10) / 10;
}

export function monthsBetweenIso(startIso, endIso) {
  const a = Date.parse(String(startIso || '').slice(0, 10));
  const b = Date.parse(String(endIso || '').slice(0, 10));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return (b - a) / (30.44 * 24 * 60 * 60 * 1000);
}

/**
 * Years since last salary history effective date, else since join.
 * @param {import('better-sqlite3').Database} db
 */
export function yearsInCurrentLevelFromHistory(db, userId, dateJoinedIso) {
  let anchorIso = String(dateJoinedIso || '').slice(0, 10);
  try {
    const hist = db
      .prepare(
        `SELECT effective_from_iso FROM hr_salary_history
         WHERE user_id = ? ORDER BY effective_from_iso DESC LIMIT 1`
      )
      .get(userId);
    if (hist?.effective_from_iso) anchorIso = String(hist.effective_from_iso).slice(0, 10);
  } catch {
    /* salary history optional */
  }
  const anchor = Date.parse(anchorIso);
  if (!Number.isFinite(anchor)) return 0;
  return roundTenureYears((Date.now() - anchor) / (365.25 * 24 * 60 * 60 * 1000));
}

export function resolveDesignationMinServiceYears(designation) {
  if (!designation) return 0;
  const explicit = designation.minServiceYears ?? designation.min_service_years;
  if (explicit != null && Number.isFinite(Number(explicit))) return Math.max(0, Number(explicit));
  const tier = String(designation.titleTier || designation.title_tier || '').trim().toLowerCase();
  return DEFAULT_MIN_YEARS_BY_TIER[tier] ?? 0;
}

export function suggestTenurePayActions({ yearsOfService = 0, yearsInCurrentLevel = 0, salaryStep = 1 } = {}) {
  const suggestions = [];
  const step = Math.round(Number(salaryStep) || 1);
  const yos = Number(yearsOfService) || 0;
  const yil = Number(yearsInCurrentLevel) || 0;
  if (yil >= 2 && step < 2) {
    suggestions.push({
      type: 'step_increment',
      suggestedStep: 2,
      reason: '2+ years at current level — eligible for Step 2 (experienced).',
    });
  }
  if (yil >= 3 && step < 3) {
    suggestions.push({
      type: 'step_increment',
      suggestedStep: 3,
      reason: '3+ years at current level — eligible for Step 3 (long service / merit).',
    });
  }
  if (yos >= 2.5 && yos < 3) {
    suggestions.push({
      type: 'promotion_review',
      reason: 'Approaching 3 years — prepare appraisal and promotion review.',
      urgency: 'approaching',
    });
  }
  if (yos >= 3 && yil >= 2) {
    suggestions.push({
      type: 'promotion_review',
      reason: '3+ years of service — promotion / level review due.',
      urgency: 'due',
    });
  }
  return suggestions;
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function getStaffTenureSummary(db, userId, { dateJoinedIso, salaryLevel, salaryStep } = {}) {
  const joined = String(dateJoinedIso || '').slice(0, 10);
  const yearsOfService = roundTenureYears(serviceYearsFromJoinedIso(joined));
  const yearsInCurrentLevel = userId ? yearsInCurrentLevelFromHistory(db, userId, joined) : yearsOfService;
  const step = Math.round(Number(salaryStep) || 1);
  const level = Math.round(Number(salaryLevel) || 0) || null;
  return {
    dateJoinedIso: joined || null,
    yearsOfService,
    yearsInCurrentLevel,
    salaryLevel: level,
    salaryStep: step,
    suggestions: suggestTenurePayActions({ yearsOfService, yearsInCurrentLevel, salaryStep: step }),
    leaveBandHint:
      level >= 6 ? 'executive' : level >= 4 ? 'senior' : level >= 3 ? 'standard' : 'junior',
  };
}

export function validateActingEndDate(endIso, { label = 'Acting appointment' } = {}) {
  const end = String(endIso || '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(end)) {
    return { ok: false, error: `${label} requires an end date (YYYY-MM-DD).` };
  }
  const months = monthsBetweenIso(new Date().toISOString().slice(0, 10), end);
  if (months == null) return { ok: false, error: `${label} end date is invalid.` };
  if (months < 0) return { ok: false, error: `${label} end date must be today or in the future.` };
  if (months > ACTING_APPOINTMENT_MAX_MONTHS + 0.15) {
    return {
      ok: false,
      error: `${label} cannot exceed ${ACTING_APPOINTMENT_MAX_MONTHS} months (policy).`,
    };
  }
  return { ok: true, endDateIso: end, monthsRemaining: Math.round(months * 10) / 10 };
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function getDesignationTenureEligibility(db, designationId, userId, { dateJoinedIso } = {}) {
  const des = getHrDesignation(db, designationId);
  if (!des) return { ok: false, error: 'Designation not found.' };
  const joined =
    String(dateJoinedIso || '').slice(0, 10) ||
    (userId
      ? db.prepare(`SELECT date_joined_iso FROM hr_staff_profiles WHERE user_id = ?`).get(userId)?.date_joined_iso
      : null);
  const tenure = getStaffTenureSummary(db, userId, {
    dateJoinedIso: joined,
    salaryLevel: des.defaultSalaryLevel,
    salaryStep: des.defaultSalaryStep,
  });
  const minYears = resolveDesignationMinServiceYears(des);
  const eligible = tenure.yearsOfService >= minYears;
  const shortfall = eligible ? 0 : roundTenureYears(minYears - tenure.yearsOfService);
  return {
    ok: true,
    designationId: des.id,
    designationTitle: des.title,
    titleTier: des.titleTier || des.title_tier || null,
    minServiceYears: minYears,
    yearsOfService: tenure.yearsOfService,
    eligible,
    shortfallYears: shortfall,
    isActing: Boolean(des.isActing) || ACTING_DESIGNATION_IDS.has(des.id),
    functionalOfficeKey: des.functionalOfficeKey || des.functional_office_key || DESIGNATION_OFFICE_KEYS[des.id] || null,
    tenure,
  };
}

function actorMayOverrideTenure(db, actorUserId) {
  if (!actorUserId) return false;
  const row = db.prepare(`SELECT role_key FROM app_users WHERE id = ?`).get(actorUserId);
  if (!row) return false;
  return (
    userHasPermission(row.role_key, 'hr.settings.manage') ||
    userHasPermission(row.role_key, 'hr.staff.manage') ||
    ['gmhr', 'md', 'admin', 'hr_admin'].includes(String(row.role_key || ''))
  );
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function validateStaffTenureForSave(db, input = {}) {
  const errors = [];
  const warnings = [];
  const designationId = String(input.designationId || '').trim();
  if (!designationId) {
    return { ok: true, errors, warnings };
  }

  const des = getHrDesignation(db, designationId);
  if (!des) {
    warnings.push('Designation not in catalog — tenure gates skipped.');
    return { ok: true, errors, warnings };
  }

  const joined = String(input.dateJoinedIso || '').slice(0, 10);
  if (!joined) {
    errors.push('Date joined is required when assigning a standard designation.');
    return { ok: false, errors, warnings };
  }

  const tenure = getStaffTenureSummary(db, input.userId, {
    dateJoinedIso: joined,
    salaryLevel: input.salaryLevel,
    salaryStep: input.salaryStep,
  });
  const minYears = resolveDesignationMinServiceYears(des);
  const override =
    input.tenureOverride === true &&
    String(input.tenureOverrideReason || '').trim().length >= 12 &&
    actorMayOverrideTenure(db, input.actorUserId);

  if (minYears > 0 && tenure.yearsOfService < minYears && !override) {
    errors.push(
      `"${des.title}" requires at least ${minYears} year(s) of service (current ~${tenure.yearsOfService} yrs). Use Assistant/Trainee title or record a tenure override with reason.`
    );
  } else if (minYears > 0 && tenure.yearsOfService < minYears && override) {
    warnings.push(`Tenure override applied for "${des.title}" (${tenure.yearsOfService} yrs < ${minYears} required).`);
  }

  const isActingDes =
    Boolean(des.isActing) ||
    ACTING_DESIGNATION_IDS.has(designationId) ||
    String(des.titleTier || des.title_tier || '').toLowerCase() === 'acting';

  if (isActingDes) {
    const actingEnd = input.actingEndDateIso || input.profileExtra?.employmentMeta?.actingEndDateIso;
    const actingCheck = validateActingEndDate(actingEnd, { label: `Acting title (${des.title})` });
    if (!actingCheck.ok) errors.push(actingCheck.error);
  }

  for (const sr of input.secondaryRoles || []) {
    if (!sr?.acting) continue;
    const actingCheck = validateActingEndDate(sr.endDateIso, {
      label: `Acting secondary role (${sr.role || 'role'})`,
    });
    if (!actingCheck.ok) errors.push(actingCheck.error);
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    tenure,
    eligibility: {
      minServiceYears: minYears,
      yearsOfService: tenure.yearsOfService,
      eligible: tenure.yearsOfService >= minYears || override,
      overridden: override,
    },
  };
}
