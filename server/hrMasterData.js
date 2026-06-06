/**
 * HR master data: departments and designations.
 * @module server/hrMasterData
 */

import { hrTablesReady } from './hrOps.js';

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
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
  let sql = `SELECT d.*, dep.name AS departmentName FROM hr_designations d
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
       job_description=@job_description, duties_responsibilities=@duties_responsibilities, reporting_line=@reporting_line,
       required_qualification=@required_qualification, skills_required=@skills_required, working_conditions=@working_conditions,
       salary_range_note=@salary_range_note, active=@active, updated_at_iso=@updated_at_iso, updated_by_user_id=@updated_by_user_id
       WHERE id=@id`
    ).run(payload);
  } else {
    db.prepare(
      `INSERT INTO hr_designations (id, title, department_id, grade_category, seniority_band, default_salary_level, default_salary_step,
       job_description, duties_responsibilities, reporting_line, required_qualification, skills_required, working_conditions,
       salary_range_note, active, created_at_iso, updated_at_iso, created_by_user_id, updated_by_user_id)
       VALUES (@id, @title, @department_id, @grade_category, @seniority_band, @default_salary_level, @default_salary_step,
       @job_description, @duties_responsibilities, @reporting_line, @required_qualification, @skills_required, @working_conditions,
       @salary_range_note, @active, @created_at_iso, @updated_at_iso, @created_by_user_id, @updated_by_user_id)`
    ).run({ ...payload, created_at_iso: ts, created_by_user_id: actor?.id || null });
  }
  return { ok: true, designation: getHrDesignation(db, id) };
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
    jobDescription: row.job_description,
    dutiesResponsibilities: row.duties_responsibilities,
    reportingLine: row.reporting_line,
    requiredQualification: row.required_qualification,
    skillsRequired: row.skills_required,
    workingConditions: row.working_conditions,
    salaryRangeNote: row.salary_range_note,
    active: Boolean(row.active),
    createdAtIso: row.created_at_iso,
    updatedAtIso: row.updated_at_iso,
  };
}
