/**
 * Salary matrix lookup, auto-fill, and above-matrix variance handling.
 * @module server/hrCompensationOps
 */

import {
  isDirectorCorporateEligible,
  normalizeSecondaryRole,
  buildStaffMergedOffices,
} from './hrOrgConstants.js';

export const COMPENSATION_VARIANCE_TYPES = [
  { value: 'merit_outstanding', label: 'Merit / outstanding performance' },
  { value: 'scarce_skill_retention', label: 'Scarce skill / retention' },
  { value: 'multi_role_consolidation', label: 'Multi-role consolidation' },
  { value: 'director_emolument', label: 'Director emolument (board)' },
  { value: 'acting_allowance', label: 'Acting role allowance' },
  { value: 'market_adjustment', label: 'Market adjustment' },
  { value: 'special_occasion', label: 'Special occasion / one-off base change' },
];

const VALID_VARIANCE_TYPES = new Set(COMPENSATION_VARIANCE_TYPES.map((t) => t.value));

function readPayAddition(body, prevExtra) {
  if (body?.payAdditionNgn !== undefined) {
    if (body.payAdditionNgn === '' || body.payAdditionNgn == null) return 0;
    return Math.max(0, Math.round(Number(body.payAdditionNgn) || 0));
  }
  if (prevExtra?.compensation?.payAdditionNgn != null) {
    return Math.max(0, Math.round(Number(prevExtra.compensation.payAdditionNgn) || 0));
  }
  return 0;
}

function applyMatrixPayComponents(matrixRow, payAdditionNgn = 0) {
  return {
    baseSalaryNgn: Math.round(Number(matrixRow.baseSalaryNgn) || 0) + Math.max(0, payAdditionNgn),
    housingAllowanceNgn: Math.round(Number(matrixRow.housingAllowanceNgn) || 0),
    transportAllowanceNgn: Math.round(Number(matrixRow.transportAllowanceNgn) || 0),
  };
}

export { isDirectorCorporateEligible, buildStaffMergedOffices };

function nowIso() {
  return new Date().toISOString();
}

export function totalCompensationNgn({ baseSalaryNgn = 0, housingAllowanceNgn = 0, transportAllowanceNgn = 0 } = {}) {
  return (
    Math.round(Number(baseSalaryNgn) || 0) +
    Math.round(Number(housingAllowanceNgn) || 0) +
    Math.round(Number(transportAllowanceNgn) || 0)
  );
}

export function salaryMatrixReady(db) {
  try {
    return Boolean(
      db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='hr_salary_matrix'`).get()
    );
  } catch {
    return false;
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function lookupHrSalaryMatrixRow(db, payrollGroup, salaryLevel, salaryStep) {
  if (!salaryMatrixReady(db)) return null;
  const group = String(payrollGroup || 'branch_ops').trim() || 'branch_ops';
  const level = Math.round(Number(salaryLevel) || 0);
  const step = Math.round(Number(salaryStep) || 0);
  if (level < 1 || step < 1) return null;
  const row = db
    .prepare(
      `SELECT payroll_group AS payrollGroup, salary_level AS salaryLevel, salary_step AS salaryStep,
              base_salary_ngn AS baseSalaryNgn, housing_allowance_ngn AS housingAllowanceNgn,
              transport_allowance_ngn AS transportAllowanceNgn, notes
       FROM hr_salary_matrix WHERE payroll_group = ? AND salary_level = ? AND salary_step = ?`
    )
    .get(group, level, step);
  return row || null;
}

export function computeCompensationVariance(matrixRow, actual) {
  if (!matrixRow) {
    return {
      matrixBaseNgn: null,
      matrixTotalNgn: null,
      actualBaseNgn: Math.round(Number(actual?.baseSalaryNgn) || 0),
      actualTotalNgn: totalCompensationNgn(actual),
      varianceNgn: null,
      aboveMatrix: false,
    };
  }
  const matrixTotal = totalCompensationNgn(matrixRow);
  const actualTotal = totalCompensationNgn(actual);
  const varianceNgn = actualTotal - matrixTotal;
  return {
    matrixBaseNgn: Math.round(Number(matrixRow.baseSalaryNgn) || 0),
    matrixHousingNgn: Math.round(Number(matrixRow.housingAllowanceNgn) || 0),
    matrixTransportNgn: Math.round(Number(matrixRow.transportAllowanceNgn) || 0),
    matrixTotalNgn: matrixTotal,
    actualBaseNgn: Math.round(Number(actual?.baseSalaryNgn) || 0),
    actualHousingNgn: Math.round(Number(actual?.housingAllowanceNgn) || 0),
    actualTransportNgn: Math.round(Number(actual?.transportAllowanceNgn) || 0),
    actualTotalNgn: actualTotal,
    varianceNgn,
    aboveMatrix: varianceNgn > 0,
  };
}

export function shouldAutoApplyMatrixPay({ existing, body, prevRow }) {
  if (body?.applyMatrixPay === true) return true;
  if (body?.applyMatrixPay === false) return false;
  if (!existing) {
    const baseUnset =
      body?.baseSalaryNgn === undefined ||
      body?.baseSalaryNgn === '' ||
      body?.baseSalaryNgn == null ||
      Math.round(Number(body.baseSalaryNgn) || 0) === 0;
    return baseUnset;
  }
  if (body?.designationId !== undefined && String(body.designationId || '') !== String(prevRow?.designation_id || '')) {
    const payUnset =
      body?.baseSalaryNgn === undefined ||
      body?.baseSalaryNgn === '' ||
      body?.baseSalaryNgn == null;
    return payUnset;
  }
  return false;
}

function readCompensationAmount(body, prevRow, key, snakeKey) {
  if (body?.[key] !== undefined) {
    if (body[key] === '' || body[key] == null) return 0;
    return Math.max(0, Math.round(Number(body[key]) || 0));
  }
  if (prevRow) return Math.max(0, Math.round(Number(prevRow[snakeKey]) || 0));
  return 0;
}

/**
 * Resolve pay for staff profile save.
 * @param {import('better-sqlite3').Database} db
 */
export function resolveStaffCompensationForSave(db, opts = {}) {
  const {
    body = {},
    prevRow = null,
    existing = false,
    resolvedSalaryLevel = null,
    resolvedSalaryStep = null,
    normalizedPayrollGroup = 'branch_ops',
    actorUserId = null,
    prevExtra = {},
    allowUndocumentedVariance = false,
    titleById = null,
  } = opts;

  const level = resolvedSalaryLevel != null ? Math.round(Number(resolvedSalaryLevel)) : null;
  const step = resolvedSalaryStep != null ? Math.round(Number(resolvedSalaryStep)) : null;
  const matrixRow =
    level && step ? lookupHrSalaryMatrixRow(db, normalizedPayrollGroup, level, step) : null;

  const payAdditionNgn = readPayAddition(body, prevExtra);
  let baseSalaryNgn = readCompensationAmount(body, prevRow, 'baseSalaryNgn', 'base_salary_ngn');
  let housingAllowanceNgn = readCompensationAmount(body, prevRow, 'housingAllowanceNgn', 'housing_allowance_ngn');
  let transportAllowanceNgn = readCompensationAmount(body, prevRow, 'transportAllowanceNgn', 'transport_allowance_ngn');

  let matrixApplied = false;
  const useMatrixModel =
    matrixRow &&
    (shouldAutoApplyMatrixPay({ existing, body, prevRow }) ||
      body?.payAdditionNgn !== undefined ||
      prevExtra?.compensation?.payAdditionNgn != null ||
      body?.applyMatrixPay === true);

  if (useMatrixModel) {
    const applied = applyMatrixPayComponents(matrixRow, payAdditionNgn);
    baseSalaryNgn = applied.baseSalaryNgn;
    housingAllowanceNgn = applied.housingAllowanceNgn;
    transportAllowanceNgn = applied.transportAllowanceNgn;
    matrixApplied = shouldAutoApplyMatrixPay({ existing, body, prevRow }) || body?.applyMatrixPay === true;
  } else if (matrixRow && shouldAutoApplyMatrixPay({ existing, body, prevRow })) {
    const applied = applyMatrixPayComponents(matrixRow, 0);
    baseSalaryNgn = applied.baseSalaryNgn;
    housingAllowanceNgn = applied.housingAllowanceNgn;
    transportAllowanceNgn = applied.transportAllowanceNgn;
    matrixApplied = true;
  }

  const actual = { baseSalaryNgn, housingAllowanceNgn, transportAllowanceNgn };
  const varianceCalc = computeCompensationVariance(matrixRow, actual);

  const extraPatch = mergeCompensationProfileExtra(prevExtra, body, {
    actorUserId,
    varianceCalc,
    matrixRow,
    designationId: body?.designationId ?? prevRow?.designation_id ?? null,
    titleById,
  });

  const warnings = [];
  if (varianceCalc.aboveMatrix) {
    const documented = Boolean(extraPatch.compensationVariance?.type);
    if (!documented && !allowUndocumentedVariance) {
      return {
        ok: false,
        error:
          'Total pay exceeds the salary matrix for this level/step. Record a compensation variance type and notes, or use Apply matrix pay to reset to standard.',
        code: 'compensation_variance_required',
        variance: varianceCalc,
        matrixRow,
      };
    }
    if (documented && !String(extraPatch.compensationVariance?.notes || '').trim()) {
      return {
        ok: false,
        error: 'Compensation variance notes are required when pay is above the matrix.',
        code: 'compensation_variance_notes_required',
        variance: varianceCalc,
      };
    }
    if (documented) {
      warnings.push({
        code: 'compensation_above_matrix',
        message: `Pay is ₦${varianceCalc.varianceNgn.toLocaleString()} above matrix (${extraPatch.compensationVariance.type}).`,
      });
    } else {
      warnings.push({
        code: 'compensation_above_matrix_undocumented',
        message: 'Pay exceeds matrix without variance documentation.',
      });
    }
  }

  return {
    ok: true,
    baseSalaryNgn,
    housingAllowanceNgn,
    transportAllowanceNgn,
    payAdditionNgn,
    matrixApplied,
    matrixRow,
    variance: varianceCalc,
    profileExtraPatch: extraPatch,
    warnings,
  };
}

export function mergeCompensationProfileExtra(prevExtra, body, ctx = {}) {
  const extra = { ...(prevExtra || {}) };
  const { varianceCalc, matrixRow, actorUserId, designationId, titleById } = ctx;

  if (body?.payAdditionNgn !== undefined || varianceCalc) {
    extra.compensation = {
      ...(extra.compensation || {}),
      payAdditionNgn: readPayAddition(body, prevExtra),
      matrixTotalNgn: varianceCalc?.matrixTotalNgn ?? extra.compensation?.matrixTotalNgn ?? null,
      updatedAtIso: nowIso(),
    };
  }

  if (body?.secondaryRoles !== undefined) {
    const roles = Array.isArray(body.secondaryRoles) ? body.secondaryRoles : [];
    extra.employmentMeta = {
      ...(extra.employmentMeta || {}),
      secondaryRoles: roles
        .map((r) => normalizeSecondaryRole(r, { titleById: titleById || {} }))
        .filter((r) => r.role),
    };
  }

  const directorEligible = isDirectorCorporateEligible({
    designationId,
    compensationVarianceType: body?.compensationVarianceType,
    prevExtra: extra,
    corporateTitle: body?.corporateTitle,
    boardMember: body?.boardMember === true,
  });

  if (body?.corporateTitle !== undefined || body?.boardMember !== undefined) {
    extra.employmentMeta = {
      ...(extra.employmentMeta || {}),
      ...(body?.boardMember !== undefined ? { boardMember: body.boardMember === true } : {}),
      corporateTitle:
        directorEligible && body?.corporateTitle !== undefined
          ? String(body.corporateTitle || '').trim() || null
          : directorEligible
            ? extra.employmentMeta?.corporateTitle ?? null
            : null,
    };
  }

  const clearVariance = body?.clearCompensationVariance === true;
  const varianceType = String(body?.compensationVarianceType || '').trim();
  const varianceNotes = String(body?.compensationVarianceNotes || '').trim();
  const varianceReviewDue = String(body?.compensationVarianceReviewDueIso || '').trim().slice(0, 10) || null;
  const varianceMemoRef = String(body?.compensationVarianceMemoRef || '').trim() || null;
  const resolvedVarianceType =
    directorEligible && String(body?.corporateTitle || extra.employmentMeta?.corporateTitle || '').trim()
      ? 'director_emolument'
      : varianceType;

  if (clearVariance) {
    delete extra.compensationVariance;
  } else if (
    resolvedVarianceType ||
    body?.compensationVarianceType !== undefined ||
    body?.compensationVarianceNotes !== undefined
  ) {
    if (resolvedVarianceType && !VALID_VARIANCE_TYPES.has(resolvedVarianceType)) {
      return extra;
    }
    if (resolvedVarianceType || varianceNotes) {
      extra.compensationVariance = {
        type: resolvedVarianceType || extra.compensationVariance?.type || null,
        notes: varianceNotes || extra.compensationVariance?.notes || null,
        reviewDueIso: varianceReviewDue || extra.compensationVariance?.reviewDueIso || null,
        memoRef: varianceMemoRef || extra.compensationVariance?.memoRef || null,
        matrixBaseNgn: matrixRow ? Math.round(Number(matrixRow.baseSalaryNgn) || 0) : varianceCalc?.matrixBaseNgn ?? null,
        matrixTotalNgn: varianceCalc?.matrixTotalNgn ?? null,
        actualBaseNgn: varianceCalc?.actualBaseNgn ?? null,
        actualTotalNgn: varianceCalc?.actualTotalNgn ?? null,
        varianceNgn: varianceCalc?.varianceNgn ?? null,
        approvedByUserId: actorUserId || extra.compensationVariance?.approvedByUserId || null,
        approvedAtIso: actorUserId ? nowIso() : extra.compensationVariance?.approvedAtIso || null,
        updatedAtIso: nowIso(),
      };
    }
  } else if (varianceCalc?.aboveMatrix && extra.compensationVariance?.type) {
    extra.compensationVariance = {
      ...extra.compensationVariance,
      matrixBaseNgn: varianceCalc.matrixBaseNgn,
      matrixTotalNgn: varianceCalc.matrixTotalNgn,
      actualBaseNgn: varianceCalc.actualBaseNgn,
      actualTotalNgn: varianceCalc.actualTotalNgn,
      varianceNgn: varianceCalc.varianceNgn,
      updatedAtIso: nowIso(),
    };
  } else if (!varianceCalc?.aboveMatrix && extra.compensationVariance && !varianceType) {
    delete extra.compensationVariance;
  }

  return extra;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} staff
 */
export function buildStaffCompensationSummary(db, staff) {
  const payrollGroup = String(staff?.payrollGroup || 'branch_ops').trim() || 'branch_ops';
  const level = staff?.salaryLevel != null ? Number(staff.salaryLevel) : null;
  const step = staff?.salaryStep != null ? Number(staff.salaryStep) : 1;
  const matrixRow = level && step ? lookupHrSalaryMatrixRow(db, payrollGroup, level, step) : null;
  const actual = {
    baseSalaryNgn: staff?.baseSalaryNgn,
    housingAllowanceNgn: staff?.housingAllowanceNgn,
    transportAllowanceNgn: staff?.transportAllowanceNgn,
  };
  const varianceCalc = computeCompensationVariance(matrixRow, actual);
  const documented = Boolean(staff?.profileExtra?.compensationVariance?.type);
  let payAdditionNgn = Math.max(0, Math.round(Number(staff?.profileExtra?.compensation?.payAdditionNgn) || 0));
  let inferredPayAddition = false;
  if (!payAdditionNgn && varianceCalc.aboveMatrix && varianceCalc.varianceNgn > 0) {
    payAdditionNgn = Math.round(varianceCalc.varianceNgn);
    inferredPayAddition = true;
  }
  return {
    ...varianceCalc,
    payAdditionNgn,
    inferredPayAddition,
    varianceDocumented: documented,
    variance: staff?.profileExtra?.compensationVariance || null,
    matrixAppliedHint: Boolean(matrixRow),
    mergedOffices: buildStaffMergedOffices(staff),
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ viewAll?: boolean; branchId?: string }} scope
 */
export function listHrSalaryVarianceReport(db, scope = {}) {
  if (!salaryMatrixReady(db)) return [];
  let sql = `
    SELECT p.user_id AS userId, u.display_name AS displayName, p.branch_id AS branchId,
           p.job_title AS jobTitle, p.payroll_group AS payrollGroup,
           p.salary_level AS salaryLevel, p.salary_step AS salaryStep,
           p.base_salary_ngn AS baseSalaryNgn, p.housing_allowance_ngn AS housingAllowanceNgn,
           p.transport_allowance_ngn AS transportAllowanceNgn, p.profile_extra_json AS profileExtraJson
    FROM hr_staff_profiles p
    JOIN app_users u ON u.id = p.user_id AND u.status = 'active'
    WHERE p.salary_level IS NOT NULL AND p.salary_step IS NOT NULL
  `;
  const args = [];
  if (!scope?.viewAll && scope?.branchId) {
    sql += ` AND p.branch_id = ?`;
    args.push(scope.branchId);
  }
  sql += ` ORDER BY u.display_name ASC`;
  const rows = db.prepare(sql).all(...args);
  const out = [];
  for (const row of rows) {
    const profileExtra = (() => {
      try {
        return JSON.parse(String(row.profileExtraJson || '{}'));
      } catch {
        return {};
      }
    })();
    const matrixRow = lookupHrSalaryMatrixRow(db, row.payrollGroup, row.salaryLevel, row.salaryStep);
    const varianceCalc = computeCompensationVariance(matrixRow, row);
    if (!varianceCalc.aboveMatrix) continue;
    out.push({
      userId: row.userId,
      displayName: row.displayName,
      branchId: row.branchId,
      jobTitle: row.jobTitle,
      payrollGroup: row.payrollGroup,
      salaryLevel: row.salaryLevel,
      salaryStep: row.salaryStep,
      matrixTotalNgn: varianceCalc.matrixTotalNgn,
      matrixBaseNgn: varianceCalc.matrixBaseNgn,
      matrixHousingNgn: varianceCalc.matrixHousingNgn,
      matrixTransportNgn: varianceCalc.matrixTransportNgn,
      actualTotalNgn: varianceCalc.actualTotalNgn,
      payAdditionNgn: profileExtra?.compensation?.payAdditionNgn ?? varianceCalc.varianceNgn,
      varianceNgn: varianceCalc.varianceNgn,
      varianceType: profileExtra?.compensationVariance?.type || null,
      varianceNotes: profileExtra?.compensationVariance?.notes || null,
      reviewDueIso: profileExtra?.compensationVariance?.reviewDueIso || null,
      secondaryRoles: profileExtra?.employmentMeta?.secondaryRoles || [],
      corporateTitle: profileExtra?.employmentMeta?.corporateTitle || null,
    });
  }
  return out;
}

function staffProfilesReady(db) {
  try {
    return Boolean(
      db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='hr_staff_profiles'`).get()
    );
  } catch {
    return false;
  }
}

function parseProfileExtraJson(raw) {
  try {
    return JSON.parse(String(raw || '{}'));
  } catch {
    return {};
  }
}

/** @param {string} todayIso YYYY-MM-DD */
export function daysUntilIsoDate(isoDate, todayIso) {
  const today = String(todayIso || new Date().toISOString().slice(0, 10)).slice(0, 10);
  const target = String(isoDate || '').slice(0, 10);
  if (!target) return null;
  const a = new Date(`${today}T00:00:00.000Z`);
  const b = new Date(`${target}T00:00:00.000Z`);
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

/**
 * Pure helper for dashboard acting-role and compensation review alerts.
 * @param {Array<{ userId: string; displayName?: string; jobTitle?: string; branchId?: string; profileExtraJson?: string; profileExtra?: object }>} rows
 * @param {{ withinDays?: number; todayIso?: string }} [opts]
 */
export function buildOrgCompensationDashboardAlerts(rows, { withinDays = 30, todayIso } = {}) {
  const today = todayIso || new Date().toISOString().slice(0, 10);
  const actingRolesExpiring = [];
  const actingRolesOverdue = [];
  const actingRolesMissingEnd = [];
  const compensationReviewDue = [];

  for (const row of rows || []) {
    const profileExtra = row.profileExtra || parseProfileExtraJson(row.profileExtraJson);
    const meta = profileExtra?.employmentMeta || {};
    const secondaryRoles = Array.isArray(meta.secondaryRoles) ? meta.secondaryRoles : [];

    for (const sr of secondaryRoles) {
      if (!sr?.acting) continue;
      const base = {
        userId: row.userId,
        displayName: row.displayName || row.userId,
        jobTitle: row.jobTitle || null,
        branchId: row.branchId || null,
        roleTitle: sr.role || sr.title || 'Acting role',
        roleBranchId: sr.branchId || null,
        notes: sr.notes || null,
      };
      if (!sr.endDateIso) {
        actingRolesMissingEnd.push({ ...base, alertType: 'acting_role_missing_end' });
        continue;
      }
      const daysRemaining = daysUntilIsoDate(sr.endDateIso, today);
      if (daysRemaining == null) continue;
      if (daysRemaining < 0) {
        actingRolesOverdue.push({
          ...base,
          endDateIso: String(sr.endDateIso).slice(0, 10),
          daysRemaining,
          alertType: 'acting_role_overdue',
        });
      } else if (daysRemaining <= withinDays) {
        actingRolesExpiring.push({
          ...base,
          endDateIso: String(sr.endDateIso).slice(0, 10),
          daysRemaining,
          alertType: 'acting_role_expiring',
        });
      }
    }

    const variance = profileExtra?.compensationVariance;
    if (variance?.reviewDueIso) {
      const daysRemaining = daysUntilIsoDate(variance.reviewDueIso, today);
      if (daysRemaining != null && daysRemaining <= withinDays) {
        compensationReviewDue.push({
          userId: row.userId,
          displayName: row.displayName || row.userId,
          jobTitle: row.jobTitle || null,
          branchId: row.branchId || null,
          reviewDueIso: String(variance.reviewDueIso).slice(0, 10),
          daysRemaining,
          varianceType: variance.type || null,
          alertType: daysRemaining < 0 ? 'compensation_review_overdue' : 'compensation_review_due',
        });
      }
    }
  }

  const actingRoleAlerts = [
    ...actingRolesOverdue,
    ...actingRolesMissingEnd,
    ...actingRolesExpiring,
  ];

  return {
    actingRolesExpiring,
    actingRolesOverdue,
    actingRolesMissingEnd,
    actingRoleAlerts,
    compensationReviewDue,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ viewAll?: boolean; branchId?: string }} scope
 */
export function listOrgCompensationDashboardAlerts(db, scope = {}) {
  const empty = {
    actingRolesExpiring: [],
    actingRolesOverdue: [],
    actingRolesMissingEnd: [],
    actingRoleAlerts: [],
    compensationReviewDue: [],
    undocumentedCompensationVariance: [],
  };
  if (!staffProfilesReady(db)) return empty;

  let sql = `
    SELECT p.user_id AS userId, u.display_name AS displayName, p.branch_id AS branchId,
           p.job_title AS jobTitle, p.profile_extra_json AS profileExtraJson
    FROM hr_staff_profiles p
    JOIN app_users u ON u.id = p.user_id AND u.status = 'active'
    WHERE 1=1
  `;
  const args = [];
  if (!scope?.viewAll && scope?.branchId) {
    sql += ` AND p.branch_id = ?`;
    args.push(scope.branchId);
  }
  sql += ` ORDER BY u.display_name ASC`;
  const rows = db.prepare(sql).all(...args);
  const built = buildOrgCompensationDashboardAlerts(rows);

  const undocumentedCompensationVariance = listHrSalaryVarianceReport(db, scope)
    .filter((r) => !r.varianceType || !String(r.varianceNotes || '').trim())
    .slice(0, 20)
    .map((r) => ({
      userId: r.userId,
      displayName: r.displayName,
      branchId: r.branchId,
      jobTitle: r.jobTitle,
      varianceNgn: r.varianceNgn,
      actualTotalNgn: r.actualTotalNgn,
      matrixTotalNgn: r.matrixTotalNgn,
      alertType: 'undocumented_variance',
    }));

  return {
    ...built,
    actingRoleAlerts: built.actingRoleAlerts.slice(0, 30),
    compensationReviewDue: built.compensationReviewDue.slice(0, 20),
    undocumentedCompensationVariance,
  };
}
