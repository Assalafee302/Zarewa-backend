/**
 * Org staff helpers: legacy pay backfill, role hints, desk coverage, validation.
 * @module server/hrOrgStaffOps
 */

import { permissionsForRole } from './auth.js';
import {
  buildStaffMergedOffices,
  DESIGNATION_OFFICE_KEYS,
  normalizeSecondaryRole,
  officeKeyLabel,
} from './hrOrgConstants.js';
import {
  computeCompensationVariance,
  lookupHrSalaryMatrixRow,
} from './hrCompensationOps.js';
import { isBeneficiaryOnlyPayrollGroup, isErpAccessRestrictedPayrollGroup } from '../shared/lib/hrStaffCohorts.js';
import { HR_PORTAL_ONLY_ROLE_KEY } from './hrStaffAccessPolicy.js';

/** designation id → suggested app role_key (permissions, not HR title) */
export const DESIGNATION_APP_ROLE_HINTS = {
  desig_md: 'md',
  desig_gmhr: 'gmhr',
  desig_hoa: 'finance_manager',
  desig_hro: 'hr_admin',
  desig_adm: 'hr_admin',
  desig_po: 'operations_officer',
  desig_mm: 'operations_officer',
  desig_dbm: 'sales_manager',
  desig_cso: 'sales_staff',
  desig_bm: 'sales_manager',
  desig_abm: 'sales_manager',
  desig_actbm: 'sales_manager',
  desig_so: 'sales_staff',
  desig_sa: 'sales_staff',
  desig_sso: 'sales_staff',
  desig_st: 'sales_staff',
  desig_sk: 'operations_officer',
  desig_ask: 'operations_officer',
  desig_ps: 'operations_officer',
  desig_op: 'operations_officer',
  desig_fa: 'operations_officer',
  desig_ssk: 'operations_officer',
  desig_actsk: 'operations_officer',
  desig_csh: 'cashier',
  desig_acsh: 'cashier',
  desig_bac: 'finance_manager',
  desig_drv: 'sales_staff',
  desig_sec: 'viewer',
  desig_cln: 'viewer',
};

const OFFICE_APP_ROLE_HINTS = {
  executive: 'md',
  hr: 'hr_admin',
  finance: 'finance_manager',
  branch_manager: 'sales_manager',
  sales: 'sales_staff',
  operations: 'operations_officer',
  production: 'operations_officer',
  procurement: 'md',
  maintenance: 'operations_officer',
  office_admin: 'hr_admin',
};

/** Reference profile for demo seed — adjust payAdditionNgn to real package. */
export const ZAREWA_DEMO_MULTI_ROLE_PROFILE = {
  designationId: 'desig_hoa',
  jobTitle: 'Head Accountant',
  departmentId: 'dept_fin',
  branchId: 'BR-KD',
  payrollGroup: 'branch_ops',
  salaryLevel: 5,
  salaryStep: 1,
  payAdditionNgn: 300_000,
  boardMember: true,
  corporateTitle: 'Director',
  compensationVarianceType: 'multi_role_consolidation',
  compensationVarianceNotes:
    'Multi-role consolidation: Head Accountant + Acting BM Kaduna + Cashier Kaduna. Board director emolument on file.',
  compensationVarianceReviewDueIso: '2026-12-31',
  secondaryRoles: [
    {
      designationId: 'desig_actbm',
      role: 'Acting Branch Manager',
      officeKey: 'branch_manager',
      branchId: 'BR-KD',
      acting: true,
      endDateIso: '2026-12-31',
      notes: 'Kaduna branch desk cover',
    },
    {
      designationId: 'desig_csh',
      role: 'Cashier',
      officeKey: 'finance',
      branchId: 'BR-KD',
      acting: false,
      notes: 'Kaduna cashier desk',
    },
  ],
};

/**
 * Supplemental permissions for secondary hats (stored in permissions_json).
 * @param {string[]} roleKeys
 * @param {string} primaryRoleKey
 */
export function buildSupplementalPermissionsForRoles(roleKeys, primaryRoleKey) {
  const primary = new Set(permissionsForRole(primaryRoleKey));
  const extra = new Set();
  for (const rk of roleKeys || []) {
    for (const p of permissionsForRole(rk)) {
      if (!primary.has(p)) extra.add(p);
    }
  }
  return [...extra].sort();
}

function nowIso() {
  return new Date().toISOString();
}

function parseExtra(raw) {
  try {
    return JSON.parse(String(raw || '{}'));
  } catch {
    return {};
  }
}

/**
 * @param {{ designationId?: string; secondaryRoles?: object[]; currentRoleKey?: string; payrollGroup?: string }} input
 */
export function recommendAppRoleKeys(input = {}) {
  const payrollGroup = String(input.payrollGroup || '').trim();
  if (payrollGroup && isBeneficiaryOnlyPayrollGroup(payrollGroup)) {
    return {
      recommendedPrimary: null,
      suggestedRoleKeys: [],
      supplementalPermissions: [],
      needsReview: true,
      note: 'Executive family and household staff do not receive ERP logins — use Chairman Accounts.',
    };
  }
  if (payrollGroup && isErpAccessRestrictedPayrollGroup(payrollGroup)) {
    return {
      recommendedPrimary: HR_PORTAL_ONLY_ROLE_KEY,
      suggestedRoleKeys: [HR_PORTAL_ONLY_ROLE_KEY],
      supplementalPermissions: [],
      needsReview: false,
      note: 'Mining division staff use HR portal only — no ERP system roles.',
    };
  }
  const suggested = new Set();
  const designationId = String(input.designationId || '').trim();
  if (DESIGNATION_APP_ROLE_HINTS[designationId]) suggested.add(DESIGNATION_APP_ROLE_HINTS[designationId]);
  for (const sr of input.secondaryRoles || []) {
    const desId = String(sr?.designationId || '').trim();
    if (DESIGNATION_APP_ROLE_HINTS[desId]) suggested.add(DESIGNATION_APP_ROLE_HINTS[desId]);
    const office = String(sr?.officeKey || DESIGNATION_OFFICE_KEYS[desId] || '').trim();
    if (OFFICE_APP_ROLE_HINTS[office]) suggested.add(OFFICE_APP_ROLE_HINTS[office]);
  }
  const current = String(input.currentRoleKey || '').trim();
  const recommendedPrimary =
    (designationId && DESIGNATION_APP_ROLE_HINTS[designationId]) || current || 'sales_staff';
  if (current) suggested.add(current);
  const list = [...suggested].filter(Boolean);
  const supplementalPermissions = buildSupplementalPermissionsForRoles(list, recommendedPrimary);
  return {
    recommendedPrimary,
    suggestedRoleKeys: list,
    supplementalPermissions,
    needsReview: list.length > 1 || (current && recommendedPrimary !== current),
    note:
      list.length > 1
        ? 'Primary role_key plus supplemental permissions_json merges permissions from secondary desks.'
        : null,
  };
}

/**
 * @param {{ designationId?: string; branchId?: string; jobTitle?: string; secondaryRoles?: object[] }} input
 */
export function validateStaffOrgRoles(input = {}) {
  const errors = [];
  const warnings = [];
  const primaryDes = String(input.designationId || '').trim();
  const branchId = String(input.branchId || '').trim();
  const primaryOffice = primaryDes ? DESIGNATION_OFFICE_KEYS[primaryDes] : null;
  const secondary = (input.secondaryRoles || []).map((r) => normalizeSecondaryRole(r));

  for (let i = 0; i < secondary.length; i += 1) {
    const sr = secondary[i];
    if (!sr.role) {
      errors.push(`Secondary role ${i + 1}: designation or title is required.`);
      continue;
    }
    if (sr.acting && !sr.endDateIso) {
      errors.push(`Acting role "${sr.role}" requires an end date.`);
    }
    if (sr.officeKey === 'branch_manager' && sr.branchId && branchId && sr.branchId === branchId && !sr.acting) {
      if (primaryOffice === 'branch_manager') {
        errors.push(`Primary job already covers Branch Manager at ${branchId}; use Acting BM or a different branch.`);
      }
    }
  }

  const deskKeys = new Set();
  if (primaryOffice && branchId) deskKeys.add(`${primaryOffice}|${branchId}|primary`);
  for (const sr of secondary) {
    if (!sr.officeKey || !sr.branchId) continue;
    const key = `${sr.officeKey}|${sr.branchId}|${sr.acting ? 'acting' : 'perm'}`;
    if (deskKeys.has(`${sr.officeKey}|${sr.branchId}|perm`) && !sr.acting) {
      warnings.push(`Duplicate desk ${officeKeyLabel(sr.officeKey)} at ${sr.branchId}.`);
    }
    deskKeys.add(key);
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ officeKey: string; branchId?: string }} query
 */
export function findStaffCoveringOffice(db, { officeKey, branchId }) {
  const targetOffice = String(officeKey || '').trim();
  if (!targetOffice) return [];
  const targetBranch = String(branchId || '').trim();
  const rows = db
    .prepare(
      `SELECT p.user_id AS userId, u.display_name AS displayName, p.branch_id AS branchId,
              p.job_title AS jobTitle, p.designation_id AS designationId, p.profile_extra_json AS profileExtraJson
       FROM hr_staff_profiles p
       JOIN app_users u ON u.id = p.user_id AND u.status = 'active'`
    )
    .all();

  const matches = [];
  for (const row of rows) {
    const profileExtra = parseExtra(row.profileExtraJson);
    const staff = {
      userId: row.userId,
      displayName: row.displayName,
      branchId: row.branchId,
      jobTitle: row.jobTitle,
      designationId: row.designationId,
      profileExtra,
    };
    const desks = buildStaffMergedOffices(staff);
    for (const d of desks) {
      if (d.officeKey !== targetOffice) continue;
      if (targetBranch && d.branchId && d.branchId !== targetBranch) continue;
      matches.push({
        userId: row.userId,
        displayName: row.displayName,
        role: d.role,
        branchId: d.branchId || row.branchId,
        primary: Boolean(d.primary),
        acting: Boolean(d.acting),
        officeKey: d.officeKey,
        officeLabel: d.label || officeKeyLabel(d.officeKey),
        score: (d.primary ? 0 : 10) + (d.acting ? 5 : 0),
      });
    }
  }
  matches.sort((a, b) => a.score - b.score || String(a.displayName).localeCompare(String(b.displayName)));
  return matches;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ officeKey: string; branchId?: string }} query
 */
export function resolveResponsibleUserForOffice(db, query) {
  const matches = findStaffCoveringOffice(db, query);
  return matches[0]?.userId || null;
}

/**
 * Infer payAdditionNgn for display when legacy profiles lack it.
 */
export function inferPayAdditionNgn(staff, matrixRow) {
  const stored = staff?.profileExtra?.compensation?.payAdditionNgn;
  if (stored != null && Number(stored) >= 0) return Math.round(Number(stored));
  if (!matrixRow) return 0;
  const variance = computeCompensationVariance(matrixRow, {
    baseSalaryNgn: staff?.baseSalaryNgn,
    housingAllowanceNgn: staff?.housingAllowanceNgn,
    transportAllowanceNgn: staff?.transportAllowanceNgn,
  });
  return variance.aboveMatrix ? Math.max(0, variance.varianceNgn || 0) : 0;
}

/**
 * Backfill legacy above-matrix pay into payAdditionNgn (+ normalize base).
 * @param {import('better-sqlite3').Database} db
 * @param {{ viewAll?: boolean; branchId?: string }} scope
 * @param {{ dryRun?: boolean; autoDocument?: boolean }} [opts]
 */
export function backfillLegacyPayAdditions(db, scope = {}, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const autoDocument = opts.autoDocument === true;
  let sql = `
    SELECT p.user_id AS userId, u.display_name AS displayName, p.branch_id AS branchId,
           p.payroll_group AS payrollGroup, p.salary_level AS salaryLevel, p.salary_step AS salaryStep,
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
  const rows = db.prepare(sql).all(...args);
  const updated = [];
  const skipped = [];

  for (const row of rows) {
    const profileExtra = parseExtra(row.profileExtraJson);
    const existingAddition = profileExtra?.compensation?.payAdditionNgn;
    if (existingAddition != null && Number(existingAddition) > 0) {
      skipped.push({ userId: row.userId, displayName: row.displayName, reason: 'already_has_addition' });
      continue;
    }
    const matrixRow = lookupHrSalaryMatrixRow(db, row.payrollGroup, row.salaryLevel, row.salaryStep);
    if (!matrixRow) {
      skipped.push({ userId: row.userId, displayName: row.displayName, reason: 'no_matrix_row' });
      continue;
    }
    const variance = computeCompensationVariance(matrixRow, row);
    if (!variance.aboveMatrix || !(variance.varianceNgn > 0)) {
      skipped.push({ userId: row.userId, displayName: row.displayName, reason: 'on_matrix' });
      continue;
    }
    const payAdditionNgn = Math.round(variance.varianceNgn);
    const newBase = Math.round(Number(matrixRow.baseSalaryNgn) || 0) + payAdditionNgn;
    const newHousing = Math.round(Number(matrixRow.housingAllowanceNgn) || 0);
    const newTransport = Math.round(Number(matrixRow.transportAllowanceNgn) || 0);

    if (!dryRun) {
      const nextExtra = {
        ...profileExtra,
        compensation: {
          ...(profileExtra.compensation || {}),
          payAdditionNgn,
          matrixTotalNgn: variance.matrixTotalNgn,
          backfilledAtIso: nowIso(),
        },
      };
      if (autoDocument && !nextExtra.compensationVariance?.type) {
        nextExtra.compensationVariance = {
          type: 'multi_role_consolidation',
          notes: 'Auto backfill from legacy pay above matrix — review and update.',
          matrixTotalNgn: variance.matrixTotalNgn,
          actualTotalNgn: variance.actualTotalNgn,
          varianceNgn: payAdditionNgn,
          updatedAtIso: nowIso(),
        };
      }
      db.prepare(
        `UPDATE hr_staff_profiles SET base_salary_ngn = ?, housing_allowance_ngn = ?, transport_allowance_ngn = ?,
         profile_extra_json = ?, updated_at_iso = ? WHERE user_id = ?`
      ).run(newBase, newHousing, newTransport, JSON.stringify(nextExtra), nowIso(), row.userId);
    }

    updated.push({
      userId: row.userId,
      displayName: row.displayName,
      payAdditionNgn,
      matrixTotalNgn: variance.matrixTotalNgn,
      previousTotalNgn: variance.actualTotalNgn,
    });
  }

  return {
    ok: true,
    dryRun,
    scanned: rows.length,
    updatedCount: updated.length,
    skippedCount: skipped.length,
    updated,
    skipped: skipped.slice(0, 50),
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ payrollGroup?: string; salaryLevel?: number; salaryStep?: number; profileExtra?: object; baseSalaryNgn?: number; housingAllowanceNgn?: number; transportAllowanceNgn?: number }} staff
 */
export function buildPayslipEarningsBreakdown(db, staff) {
  const level = staff?.salaryLevel != null ? Number(staff.salaryLevel) : null;
  const step = staff?.salaryStep != null ? Number(staff.salaryStep) : 1;
  const payrollGroup = String(staff?.payrollGroup || 'branch_ops').trim() || 'branch_ops';
  const matrixRow = level && step ? lookupHrSalaryMatrixRow(db, payrollGroup, level, step) : null;
  const profileExtra = staff?.profileExtra || {};
  let payAdditionNgn = Math.max(0, Math.round(Number(profileExtra?.compensation?.payAdditionNgn) || 0));
  const matrixBaseNgn = matrixRow ? Math.round(Number(matrixRow.baseSalaryNgn) || 0) : null;
  const matrixHousingNgn = matrixRow ? Math.round(Number(matrixRow.housingAllowanceNgn) || 0) : null;
  const matrixTransportNgn = matrixRow ? Math.round(Number(matrixRow.transportAllowanceNgn) || 0) : null;
  const matrixTotalNgn =
    matrixBaseNgn != null ? matrixBaseNgn + matrixHousingNgn + matrixTransportNgn : null;
  if (!payAdditionNgn && matrixRow) {
    payAdditionNgn = inferPayAdditionNgn(staff, matrixRow);
  }
  return {
    matrixBaseNgn,
    matrixHousingNgn,
    matrixTransportNgn,
    matrixTotalNgn,
    payAdditionNgn,
  };
}

export function resolveDemoProfileUserId(db, opts = {}) {
  const explicit = String(opts.userId || '').trim();
  if (explicit) {
    const row = db.prepare(`SELECT id FROM app_users WHERE id = ? AND status = 'active'`).get(explicit);
    if (row) return explicit;
  }
  const fm = db
    .prepare(`SELECT id FROM app_users WHERE role_key = 'finance_manager' AND status = 'active' LIMIT 1`)
    .get();
  if (fm?.id) return fm.id;
  const fallback = String(opts.fallbackUserId || '').trim();
  return fallback || null;
}
