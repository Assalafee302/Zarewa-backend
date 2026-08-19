/**
 * HR master data: departments and designations.
 * @module server/hrMasterData
 */

import { hasColumn } from './ap2ReceivedBasisOps.js';
import { HR_STAFF_BANDS } from '../shared/lib/hrRoleCompliance.js';
import { recomputeRoleComplianceForDesignation } from './hrRoleComplianceOps.js';

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function normalizeStaffBand(raw) {
  const v = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (!v) return null;
  return HR_STAFF_BANDS.includes(v) ? v : undefined;
}

function nullableNumber(value) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function persistDesignationRoleRequirementColumns(db, id, body) {
  const sets = [];
  const params = [];
  let prev = null;
  try {
    prev = db
      .prepare(
        `SELECT staff_band, min_qualification_rank, max_tenure_years FROM hr_designations WHERE id = ?`
      )
      .get(id);
  } catch {
    prev = null;
  }

  if (hasColumn(db, 'hr_designations', 'staff_band')) {
    const input = body?.staffBand ?? body?.staff_band;
    const band = input !== undefined ? normalizeStaffBand(input) : prev?.staff_band ?? null;
    sets.push('staff_band = ?');
    params.push(band ?? null);
  }
  if (hasColumn(db, 'hr_designations', 'min_qualification_rank')) {
    const input = body?.minQualificationRank ?? body?.min_qualification_rank;
    const rank = input !== undefined ? nullableNumber(input) : prev?.min_qualification_rank ?? null;
    sets.push('min_qualification_rank = ?');
    params.push(rank == null ? null : Math.round(rank));
  }
  if (hasColumn(db, 'hr_designations', 'max_tenure_years')) {
    const input = body?.maxTenureYears ?? body?.max_tenure_years;
    const years = input !== undefined ? nullableNumber(input) : prev?.max_tenure_years ?? null;
    sets.push('max_tenure_years = ?');
    params.push(years);
  }
  if (!sets.length) return { ok: true };
  params.push(id);
  db.prepare(`UPDATE hr_designations SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return { ok: true };
}

export function hrMasterDataTablesReady(db) {
  try {
    return Boolean(
      db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='hr_departments'`).get()
    );
  } catch {
    return false;
  }
}

export function listHrDepartments(db, scope = {}, { includeInactive = false } = {}) {
  if (!hrMasterDataTablesReady(db)) return [];
  let sql = `SELECT * FROM hr_departments WHERE 1=1`;
  const params = [];
  if (!includeInactive) {
    sql += ` AND active = 1`;
  }
  if (scope.branchId) {
    sql += ` AND (branch_scope IS NULL OR branch_scope = '' OR branch_scope = ? OR branch_scope = 'HQ')`;
    params.push(scope.branchId);
  }
  sql += ` ORDER BY name ASC`;
  return db
    .prepare(sql)
    .all(...params)
    .map(mapDepartmentRow);
}

export function getHrDepartment(db, id) {
  if (!hrMasterDataTablesReady(db)) return null;
  const row = db.prepare(`SELECT * FROM hr_departments WHERE id = ?`).get(id);
  return row ? mapDepartmentRow(row) : null;
}

export function upsertHrDepartment(db, body, actor) {
  if (!hrMasterDataTablesReady(db)) return { ok: false, error: 'HR master data not initialised.' };
  const name = String(body?.name || '').trim();
  const code = String(body?.code || '').trim().toUpperCase();
  if (!name) return { ok: false, error: 'Department name is required.' };
  if (!code) return { ok: false, error: 'Department code is required.' };
  const id = String(body?.id || '').trim() || newId('dept');
  const ts = nowIso();
  const payload = {
    id,
    name,
    code,
    branch_scope: String(body?.branchScope || body?.branch_scope || '').trim() || null,
    head_user_id: String(body?.headUserId || body?.head_user_id || '').trim() || null,
    description: String(body?.description || '').trim() || null,
    active: body?.active === false || body?.active === 0 ? 0 : 1,
    updated_at_iso: ts,
    updated_by_user_id: actor?.id || null,
  };
  const exists = db.prepare(`SELECT id FROM hr_departments WHERE id = ?`).get(id);
  if (exists) {
    db.prepare(
      `UPDATE hr_departments SET name=@name, code=@code, branch_scope=@branch_scope, head_user_id=@head_user_id,
       description=@description, active=@active, updated_at_iso=@updated_at_iso, updated_by_user_id=@updated_by_user_id
       WHERE id=@id`
    ).run(payload);
  } else {
    db.prepare(
      `INSERT INTO hr_departments (id, name, code, branch_scope, head_user_id, description, active, created_at_iso, updated_at_iso, created_by_user_id, updated_by_user_id)
       VALUES (@id, @name, @code, @branch_scope, @head_user_id, @description, @active, @created_at_iso, @updated_at_iso, @created_by_user_id, @updated_by_user_id)`
    ).run({ ...payload, created_at_iso: ts, created_by_user_id: actor?.id || null });
  }
  return { ok: true, department: getHrDepartment(db, id) };
}

export function listHrDesignations(db, { departmentId, includeInactive = false } = {}) {
  if (!hrMasterDataTablesReady(db)) return [];
  let sql = `SELECT d.*, dep.name AS departmentName,
             (SELECT COUNT(*) FROM hr_staff_profiles sp WHERE sp.designation_id = d.id) AS staffCount
             FROM hr_designations d
             LEFT JOIN hr_departments dep ON dep.id = d.department_id WHERE 1=1`;
  const params = [];
  if (!includeInactive) sql += ` AND d.active = 1`;
  if (departmentId) {
    sql += ` AND d.department_id = ?`;
    params.push(departmentId);
  }
  sql += ` ORDER BY d.title ASC`;
  return db.prepare(sql).all(...params).map(mapDesignationRow);
}

export function getHrDesignation(db, id) {
  if (!hrMasterDataTablesReady(db)) return null;
  const row = db
    .prepare(
      `SELECT d.*, dep.name AS departmentName FROM hr_designations d
       LEFT JOIN hr_departments dep ON dep.id = d.department_id WHERE d.id = ?`
    )
    .get(id);
  return row ? mapDesignationRow(row) : null;
}

export function upsertHrDesignation(db, body, actor) {
  if (!hrMasterDataTablesReady(db)) return { ok: false, error: 'HR master data not initialised.' };
  const title = String(body?.title || '').trim();
  if (!title) return { ok: false, error: 'Job title is required.' };
  const bandInput = body?.staffBand ?? body?.staff_band;
  if (bandInput !== undefined && bandInput !== null && String(bandInput).trim() && normalizeStaffBand(bandInput) === undefined) {
    return {
      ok: false,
      error: 'staff_band must be director, manager, senior_staff, junior_staff, or entry_staff.',
    };
  }
  const id = String(body?.id || '').trim() || newId('desig');
  const ts = nowIso();
  const payload = {
    id,
    title,
    department_id: String(body?.departmentId || body?.department_id || '').trim() || null,
    grade_category: String(body?.gradeCategory || body?.grade_category || '').trim() || null,
    seniority_band: String(body?.seniorityBand || body?.seniority_band || '').trim() || null,
    default_salary_level: body?.defaultSalaryLevel ?? body?.default_salary_level ?? null,
    default_salary_step: body?.defaultSalaryStep ?? body?.default_salary_step ?? null,
    min_service_years:
      body?.minServiceYears !== undefined
        ? body.minServiceYears === '' || body.minServiceYears == null
          ? null
          : Number(body.minServiceYears)
        : body?.min_service_years ?? null,
    title_tier: String(body?.titleTier || body?.title_tier || '').trim() || null,
    functional_office_key: String(body?.functionalOfficeKey || body?.functional_office_key || '').trim() || null,
    is_acting: body?.isActing === true || body?.is_acting === 1 || body?.is_acting === true ? 1 : 0,
    job_description: String(body?.jobDescription || body?.job_description || '').trim() || null,
    duties_responsibilities: String(body?.dutiesResponsibilities || body?.duties_responsibilities || '').trim() || null,
    reporting_line: String(body?.reportingLine || body?.reporting_line || '').trim() || null,
    required_qualification: String(body?.requiredQualification || body?.required_qualification || '').trim() || null,
    skills_required: String(body?.skillsRequired || body?.skills_required || '').trim() || null,
    working_conditions: String(body?.workingConditions || body?.working_conditions || '').trim() || null,
    salary_range_note: String(body?.salaryRangeNote || body?.salary_range_note || '').trim() || null,
    active: body?.active === false || body?.active === 0 ? 0 : 1,
    updated_at_iso: ts,
    updated_by_user_id: actor?.id || null,
  };
  const exists = db.prepare(`SELECT id FROM hr_designations WHERE id = ?`).get(id);
  if (exists) {
    db.prepare(
      `UPDATE hr_designations SET title=@title, department_id=@department_id, grade_category=@grade_category,
       seniority_band=@seniority_band, default_salary_level=@default_salary_level, default_salary_step=@default_salary_step,
       min_service_years=@min_service_years, title_tier=@title_tier, functional_office_key=@functional_office_key, is_acting=@is_acting,
       job_description=@job_description, duties_responsibilities=@duties_responsibilities, reporting_line=@reporting_line,
       required_qualification=@required_qualification, skills_required=@skills_required, working_conditions=@working_conditions,
       salary_range_note=@salary_range_note, active=@active, updated_at_iso=@updated_at_iso, updated_by_user_id=@updated_by_user_id
       WHERE id=@id`
    ).run(payload);
  } else {
    db.prepare(
      `INSERT INTO hr_designations (id, title, department_id, grade_category, seniority_band, default_salary_level, default_salary_step,
       min_service_years, title_tier, functional_office_key, is_acting,
       job_description, duties_responsibilities, reporting_line, required_qualification, skills_required, working_conditions,
       salary_range_note, active, created_at_iso, updated_at_iso, created_by_user_id, updated_by_user_id)
       VALUES (@id, @title, @department_id, @grade_category, @seniority_band, @default_salary_level, @default_salary_step,
       @min_service_years, @title_tier, @functional_office_key, @is_acting,
       @job_description, @duties_responsibilities, @reporting_line, @required_qualification, @skills_required, @working_conditions,
       @salary_range_note, @active, @created_at_iso, @updated_at_iso, @created_by_user_id, @updated_by_user_id)`
    ).run({ ...payload, created_at_iso: ts, created_by_user_id: actor?.id || null });
  }
  persistDesignationRoleRequirementColumns(db, id, body);
  recomputeRoleComplianceForDesignation(db, id);
  return { ok: true, designation: getHrDesignation(db, id) };
}

export function countStaffOnDesignation(db, designationId) {
  try {
    return (
      db
        .prepare(`SELECT COUNT(*) AS c FROM hr_staff_profiles WHERE designation_id = ?`)
        .get(String(designationId || '').trim())?.c || 0
    );
  } catch {
    return 0;
  }
}

/**
 * Soft-delete (deactivate) or hard-delete a designation when unused.
 * @param {import('better-sqlite3').Database} db
 */
export function deleteHrDesignation(db, id, actor, { hard = false } = {}) {
  if (!hrMasterDataTablesReady(db)) return { ok: false, error: 'HR master data not initialised.' };
  const desId = String(id || '').trim();
  if (!desId) return { ok: false, error: 'Designation id is required.' };
  const exists = db.prepare(`SELECT id, title FROM hr_designations WHERE id = ?`).get(desId);
  if (!exists) return { ok: false, error: 'Designation not found.' };
  const staffCount = countStaffOnDesignation(db, desId);
  const ts = nowIso();
  if (hard) {
    if (staffCount > 0) {
      return {
        ok: false,
        error: `Cannot delete — ${staffCount} staff member(s) still use this title. Deactivate instead or reassign them first.`,
        staffCount,
      };
    }
    db.prepare(`DELETE FROM hr_designations WHERE id = ?`).run(desId);
    return { ok: true, deleted: true, id: desId, staffCount: 0 };
  }
  db.prepare(
    `UPDATE hr_designations SET active=0, updated_at_iso=?, updated_by_user_id=? WHERE id=?`
  ).run(ts, actor?.id || null, desId);
  return { ok: true, deactivated: true, id: desId, staffCount };
}

export function deleteHrDepartment(db, id, actor, { hard = false } = {}) {
  if (!hrMasterDataTablesReady(db)) return { ok: false, error: 'HR master data not initialised.' };
  const deptId = String(id || '').trim();
  if (!deptId) return { ok: false, error: 'Department id is required.' };
  const exists = db.prepare(`SELECT id FROM hr_departments WHERE id = ?`).get(deptId);
  if (!exists) return { ok: false, error: 'Department not found.' };
  let desCount = 0;
  let staffCount = 0;
  try {
    desCount = db.prepare(`SELECT COUNT(*) AS c FROM hr_designations WHERE department_id = ?`).get(deptId)?.c || 0;
    staffCount = db.prepare(`SELECT COUNT(*) AS c FROM hr_staff_profiles WHERE department_id = ?`).get(deptId)?.c || 0;
  } catch {
    /* ignore */
  }
  const ts = nowIso();
  if (hard) {
    if (desCount > 0 || staffCount > 0) {
      return {
        ok: false,
        error: 'Cannot delete department while designations or staff are linked. Deactivate instead.',
        desCount,
        staffCount,
      };
    }
    db.prepare(`DELETE FROM hr_departments WHERE id = ?`).run(deptId);
    return { ok: true, deleted: true, id: deptId };
  }
  db.prepare(
    `UPDATE hr_departments SET active=0, updated_at_iso=?, updated_by_user_id=? WHERE id=?`
  ).run(ts, actor?.id || null, deptId);
  return { ok: true, deactivated: true, id: deptId, desCount, staffCount };
}

function mapDepartmentRow(row) {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    branchScope: row.branch_scope,
    headUserId: row.head_user_id,
    description: row.description,
    active: Boolean(row.active),
    createdAtIso: row.created_at_iso,
    updatedAtIso: row.updated_at_iso,
  };
}

function mapDesignationRow(row) {
  return {
    id: row.id,
    title: row.title,
    departmentId: row.department_id,
    departmentName: row.departmentName || null,
    gradeCategory: row.grade_category,
    seniorityBand: row.seniority_band,
    defaultSalaryLevel: row.default_salary_level,
    defaultSalaryStep: row.default_salary_step,
    minServiceYears: row.min_service_years,
    titleTier: row.title_tier,
    functionalOfficeKey: row.functional_office_key,
    isActing: Boolean(row.is_acting),
    jobDescription: row.job_description,
    dutiesResponsibilities: row.duties_responsibilities,
    reportingLine: row.reporting_line,
    requiredQualification: row.required_qualification,
    skillsRequired: row.skills_required,
    workingConditions: row.working_conditions,
    salaryRangeNote: row.salary_range_note,
    staffBand: row.staff_band || null,
    minQualificationRank: row.min_qualification_rank != null ? Number(row.min_qualification_rank) : null,
    maxTenureYears: row.max_tenure_years != null ? Number(row.max_tenure_years) : null,
    staffCount: Number(row.staffCount) || 0,
    active: Boolean(row.active),
    createdAtIso: row.created_at_iso,
    updatedAtIso: row.updated_at_iso,
  };
}
