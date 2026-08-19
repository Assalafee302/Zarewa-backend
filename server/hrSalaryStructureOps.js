/**
 * Versioned salary structure — source of truth for payroll gross.
 * Append-only amounts. Company-wide rows use branch_id = ''.
 */
import { hasColumn } from './ap2ReceivedBasisOps.js';
import {
  isPayrollRunEligible,
  PAYROLL_RUN_ELIGIBLE_GROUPS,
} from '../shared/lib/hrStaffCohorts.js';

export const SALARY_STRUCTURE_STATUS = {
  proposed: 'proposed',
  current: 'current',
  superseded: 'superseded',
};

export function actorDeniedHqPayControl(actor) {
  return String(actor?.roleKey || actor?.role_key || '').toLowerCase() === 'sales_manager';
}

export function salaryStructureTablesReady(db) {
  try {
    return hasColumn(db, 'hr_salary_structure_versions', 'amount_ngn');
  } catch {
    return false;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function todayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

export function normalizeStructureBranchId(raw) {
  return String(raw || '').trim();
}

export function periodEndIso(periodYyyymm) {
  const key = String(periodYyyymm || '').replace(/\D/g, '').slice(0, 6);
  if (!/^\d{6}$/.test(key)) return todayIsoDate();
  const y = Number(key.slice(0, 4));
  const m = Number(key.slice(4, 6));
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
}

function mapVersionRow(row, branchNameById = new Map()) {
  const branchId = normalizeStructureBranchId(row.branch_id);
  return {
    id: row.id,
    designationId: row.designation_id,
    designationTitle: row.designation_title || row.designationTitle || null,
    branchId,
    branchLabel: branchId ? branchNameById.get(branchId) || branchId : 'Company-wide',
    amountNgn: Math.round(Number(row.amount_ngn) || 0),
    effectiveFromIso: String(row.effective_from_iso || '').slice(0, 10) || null,
    status: row.status,
    notes: row.notes || null,
    proposedByUserId: row.proposed_by_user_id || null,
    proposedAtIso: row.proposed_at_iso || null,
    approvedByUserId: row.approved_by_user_id || null,
    approvedAtIso: row.approved_at_iso || null,
    createdAtIso: row.created_at_iso || null,
  };
}

function branchNameMap(db) {
  const map = new Map();
  try {
    const rows = db.prepare(`SELECT id, name FROM branches`).all();
    for (const r of rows) map.set(String(r.id), r.name || r.id);
  } catch {
    /* branches table may be missing in stripped tests */
  }
  return map;
}

export function loadSalaryStructureIndex(db) {
  if (!salaryStructureTablesReady(db)) return [];
  return db
    .prepare(
      `SELECT v.*, d.title AS designation_title
       FROM hr_salary_structure_versions v
       LEFT JOIN hr_designations d ON d.id = v.designation_id
       ORDER BY v.effective_from_iso DESC, v.created_at_iso DESC`
    )
    .all();
}

/**
 * Latest approved (current or superseded) row as-of a date.
 * Branch-specific beats company-wide.
 */
export function resolveSalaryStructureFromIndex(index, { designationId, branchId, asOfIso } = {}) {
  const desig = String(designationId || '').trim();
  if (!desig || !Array.isArray(index) || !index.length) return null;
  const branch = normalizeStructureBranchId(branchId);
  const asOf = String(asOfIso || todayIsoDate()).slice(0, 10);
  const eligible = (row) => {
    if (String(row.designation_id) !== desig) return false;
    if (String(row.status) === SALARY_STRUCTURE_STATUS.proposed) return false;
    const eff = String(row.effective_from_iso || '').slice(0, 10);
    return !eff || eff <= asOf;
  };
  const branchHit = index.find((row) => eligible(row) && normalizeStructureBranchId(row.branch_id) === branch);
  if (branchHit) return branchHit;
  return index.find((row) => eligible(row) && normalizeStructureBranchId(row.branch_id) === '') || null;
}

export function resolveStaffSalaryForPayroll(db, { designationId, branchId, asOfIso, profileBaseNgn, profileHousingNgn, profileTransportNgn }) {
  const index = loadSalaryStructureIndex(db);
  const hit = resolveSalaryStructureFromIndex(index, { designationId, branchId, asOfIso });
  if (hit) {
    return {
      amountNgn: Math.round(Number(hit.amount_ngn) || 0),
      salaryVersionId: hit.id,
      paySource: 'structure',
    };
  }
  const fallback =
    Math.round(Number(profileBaseNgn) || 0) +
    Math.round(Number(profileHousingNgn) || 0) +
    Math.round(Number(profileTransportNgn) || 0);
  return { amountNgn: fallback, salaryVersionId: null, paySource: 'profile_fallback' };
}

export function listHrSalaryStructureVersions(db, { status, designationId, branchId } = {}) {
  if (!salaryStructureTablesReady(db)) return [];
  const names = branchNameMap(db);
  let sql = `SELECT v.*, d.title AS designation_title
             FROM hr_salary_structure_versions v
             LEFT JOIN hr_designations d ON d.id = v.designation_id WHERE 1=1`;
  const params = [];
  if (status) {
    sql += ` AND v.status = ?`;
    params.push(String(status));
  }
  if (designationId) {
    sql += ` AND v.designation_id = ?`;
    params.push(String(designationId));
  }
  if (branchId !== undefined) {
    sql += ` AND v.branch_id = ?`;
    params.push(normalizeStructureBranchId(branchId));
  }
  sql += ` ORDER BY v.status ASC, v.effective_from_iso DESC, d.title ASC`;
  return db.prepare(sql).all(...params).map((row) => mapVersionRow(row, names));
}

export function proposeHrSalaryStructureVersion(db, body, actor) {
  if (actorDeniedHqPayControl(actor)) {
    return { ok: false, code: 'HQ_PAY_DENIED', error: 'Branch managers cannot change salary structure. HQ only.' };
  }
  if (!salaryStructureTablesReady(db)) return { ok: false, error: 'Salary structure is not initialised.' };
  const designationId = String(body?.designationId || body?.designation_id || '').trim();
  if (!designationId) return { ok: false, error: 'Choose a job title (designation).' };
  const des = db.prepare(`SELECT id, title FROM hr_designations WHERE id = ?`).get(designationId);
  if (!des) return { ok: false, error: 'Designation not found.' };
  const amountNgn = Math.round(Number(body?.amountNgn ?? body?.amount_ngn));
  if (!Number.isFinite(amountNgn) || amountNgn <= 0) {
    return { ok: false, error: 'Monthly salary amount must be a positive naira figure.' };
  }
  const effectiveFromIso = String(body?.effectiveFromIso || body?.effective_from_iso || todayIsoDate()).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFromIso)) {
    return { ok: false, error: 'Effective date must be YYYY-MM-DD.' };
  }
  const branchId = normalizeStructureBranchId(body?.branchId ?? body?.branch_id);
  const ts = nowIso();
  const id = String(body?.id || '').trim() || newId('SALV');
  db.prepare(
    `INSERT INTO hr_salary_structure_versions (
      id, designation_id, branch_id, amount_ngn, effective_from_iso, status,
      proposed_by_user_id, proposed_at_iso, notes, created_at_iso
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    designationId,
    branchId,
    amountNgn,
    effectiveFromIso,
    SALARY_STRUCTURE_STATUS.proposed,
    actor?.id || null,
    ts,
    String(body?.notes || '').trim() || null,
    ts
  );
  const names = branchNameMap(db);
  const row = db
    .prepare(
      `SELECT v.*, d.title AS designation_title FROM hr_salary_structure_versions v
       LEFT JOIN hr_designations d ON d.id = v.designation_id WHERE v.id = ?`
    )
    .get(id);
  return { ok: true, version: mapVersionRow(row, names) };
}

export function approveHrSalaryStructureVersion(db, versionId, actor) {
  if (actorDeniedHqPayControl(actor)) {
    return { ok: false, code: 'HQ_PAY_DENIED', error: 'Branch managers cannot approve salary structure. HQ only.' };
  }
  if (!salaryStructureTablesReady(db)) return { ok: false, error: 'Salary structure is not initialised.' };
  const id = String(versionId || '').trim();
  const row = db.prepare(`SELECT * FROM hr_salary_structure_versions WHERE id = ?`).get(id);
  if (!row) return { ok: false, error: 'Salary structure version not found.' };
  if (row.status !== SALARY_STRUCTURE_STATUS.proposed) {
    return { ok: false, error: 'Only proposed versions can be approved.' };
  }
  const ts = nowIso();
  const apply = db.transaction(() => {
    db.prepare(
      `UPDATE hr_salary_structure_versions SET status = ?
       WHERE designation_id = ? AND branch_id = ? AND status = ? AND id != ?`
    ).run(
      SALARY_STRUCTURE_STATUS.superseded,
      row.designation_id,
      row.branch_id,
      SALARY_STRUCTURE_STATUS.current,
      id
    );
    db.prepare(
      `UPDATE hr_salary_structure_versions
       SET status = ?, approved_by_user_id = ?, approved_at_iso = ?
       WHERE id = ?`
    ).run(SALARY_STRUCTURE_STATUS.current, actor?.id || null, ts, id);
  });
  apply();
  const names = branchNameMap(db);
  const next = db
    .prepare(
      `SELECT v.*, d.title AS designation_title FROM hr_salary_structure_versions v
       LEFT JOIN hr_designations d ON d.id = v.designation_id WHERE v.id = ?`
    )
    .get(id);
  return { ok: true, version: mapVersionRow(next, names) };
}

export function withdrawHrSalaryStructureVersion(db, versionId, actor) {
  if (actorDeniedHqPayControl(actor)) {
    return { ok: false, code: 'HQ_PAY_DENIED', error: 'Branch managers cannot change salary structure. HQ only.' };
  }
  if (!salaryStructureTablesReady(db)) return { ok: false, error: 'Salary structure is not initialised.' };
  const id = String(versionId || '').trim();
  const row = db.prepare(`SELECT id, status FROM hr_salary_structure_versions WHERE id = ?`).get(id);
  if (!row) return { ok: false, error: 'Salary structure version not found.' };
  if (row.status !== SALARY_STRUCTURE_STATUS.proposed) {
    return { ok: false, error: 'Only proposed versions can be withdrawn. Approved pay is append-only.' };
  }
  db.prepare(`DELETE FROM hr_salary_structure_versions WHERE id = ?`).run(id);
  return { ok: true, withdrawn: true, id };
}

export function listHrPayRegister(db) {
  if (!salaryStructureTablesReady(db)) return [];
  const index = loadSalaryStructureIndex(db);
  const asOf = todayIsoDate();
  const staff = db
    .prepare(
      `SELECT p.user_id, u.display_name AS displayName, p.employee_no, p.branch_id, p.designation_id,
              d.title AS designationTitle, p.job_title AS jobTitle,
              p.base_salary_ngn, p.housing_allowance_ngn, p.transport_allowance_ngn, p.payroll_group
       FROM hr_staff_profiles p
       JOIN app_users u ON u.id = p.user_id AND u.status = 'active'
       LEFT JOIN hr_designations d ON d.id = p.designation_id
       WHERE COALESCE(p.payroll_group, 'branch_ops') IN (${PAYROLL_RUN_ELIGIBLE_GROUPS.map(() => '?').join(',')})
       ORDER BY u.display_name ASC`
    )
    .all(...PAYROLL_RUN_ELIGIBLE_GROUPS);
  const names = branchNameMap(db);
  return staff
    .filter((s) => isPayrollRunEligible(s.payroll_group))
    .map((s) => {
      const resolved = resolveSalaryStructureFromIndex(index, {
        designationId: s.designation_id,
        branchId: s.branch_id,
        asOfIso: asOf,
      });
      const profileTotal =
        Math.round(Number(s.base_salary_ngn) || 0) +
        Math.round(Number(s.housing_allowance_ngn) || 0) +
        Math.round(Number(s.transport_allowance_ngn) || 0);
      const branchId = String(s.branch_id || '').trim();
      return {
        userId: s.user_id,
        displayName: s.displayName,
        employeeNo: s.employee_no || null,
        branchId,
        branchLabel: branchId ? names.get(branchId) || branchId : '—',
        designationId: s.designation_id || null,
        designationTitle: s.designationTitle || s.jobTitle || null,
        salaryVersionId: resolved?.id || null,
        amountNgn: resolved ? Math.round(Number(resolved.amount_ngn) || 0) : null,
        paySource: resolved ? 'structure' : s.designation_id ? 'missing_structure' : 'no_designation',
        profileFallbackNgn: profileTotal,
      };
    });
}

export function getHrPayOverview(db) {
  const register = salaryStructureTablesReady(db) ? listHrPayRegister(db) : [];
  const current = salaryStructureTablesReady(db)
    ? listHrSalaryStructureVersions(db, { status: SALARY_STRUCTURE_STATUS.current })
    : [];
  const proposed = salaryStructureTablesReady(db)
    ? listHrSalaryStructureVersions(db, { status: SALARY_STRUCTURE_STATUS.proposed })
    : [];
  const missing = register.filter((r) => r.paySource !== 'structure');
  let latestRun = null;
  try {
    const row = db
      .prepare(
        `SELECT id, period_yyyymm AS periodYyyymm, status FROM hr_payroll_runs ORDER BY period_yyyymm DESC LIMIT 1`
      )
      .get();
    latestRun = row || null;
  } catch {
    latestRun = null;
  }
  return {
    currentCount: current.length,
    proposedCount: proposed.length,
    staffOnStructure: register.filter((r) => r.paySource === 'structure').length,
    staffMissingStructure: missing.length,
    staffHeadcount: register.length,
    latestRun,
    missingStaff: missing.slice(0, 12),
  };
}

export function assessmentDisciplinaryForUser(db, userId, branchId, periodYyyymm) {
  try {
    const row = db
      .prepare(
        `SELECT l.disciplinary_deduction_ngn AS amount
         FROM hr_assessment_report_lines l
         JOIN hr_assessment_reports r ON r.id = l.report_id
         WHERE l.user_id = ? AND r.period_yyyymm = ? AND r.branch_id = ?
         LIMIT 1`
      )
      .get(userId, periodYyyymm, branchId);
    return Math.max(0, Math.round(Number(row?.amount) || 0));
  } catch {
    return 0;
  }
}
