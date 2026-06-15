/**
 * Seed Zarewa standard departments, designations, and salary matrix rows.
 * @module server/hrOrgSeed
 */

import { HR_FUNCTIONAL_OFFICES, DESIGNATION_OFFICE_KEYS, DIRECTOR_CORPORATE_DESIGNATION_IDS } from './hrOrgConstants.js';
import { hrMasterDataTablesReady } from './hrMasterData.js';
import { salaryMatrixReady } from './hrCompensationOps.js';

function nowIso() {
  return new Date().toISOString();
}

const DEPARTMENTS = [
  { id: 'dept_exec', code: 'EXEC', name: 'Executive', branchScope: 'HQ', description: 'Managing Director and executive office' },
  { id: 'dept_hr', code: 'HR', name: 'Human Resources', branchScope: 'HQ', description: 'HR and people operations' },
  { id: 'dept_fin', code: 'FIN', name: 'Finance & Accounts', branchScope: 'HQ', description: 'Finance, treasury, and accounts' },
  { id: 'dept_adm', code: 'ADM', name: 'Administration', branchScope: 'HQ', description: 'Office administration' },
  { id: 'dept_branch', code: 'BRANCH', name: 'Branch Management', branchScope: 'BRANCH', description: 'Factory branch leadership' },
  { id: 'dept_sales', code: 'SALES', name: 'Sales & Commercial', branchScope: 'BRANCH', description: 'Sales and customer service' },
  { id: 'dept_ops', code: 'OPS', name: 'Operations & Production', branchScope: 'BRANCH', description: 'Store, production, and logistics floor' },
  { id: 'dept_proc', code: 'PROC', name: 'Procurement & Supply', branchScope: 'HQ', description: 'Purchasing and vendor management' },
  { id: 'dept_maint', code: 'MAINT', name: 'Maintenance', branchScope: 'BRANCH', description: 'Plant and premises maintenance' },
];

/** @type {Array<{ id: string; code: string; departmentCode: string; title: string; level: number; step: number; grade: string; seniority: string; siteScope: string; notes: string }>} */
const DESIGNATIONS = [
  { id: 'desig_md', code: 'MD', departmentCode: 'EXEC', title: 'Managing Director', level: 7, step: 1, grade: 'G6-G7', seniority: 'leadership', siteScope: 'HQ', notes: 'Executive + procurement owner' },
  { id: 'desig_gmhr', code: 'GMHR', departmentCode: 'HR', title: 'General Manager – Human Resources', level: 6, step: 1, grade: 'G5-G6', seniority: 'leadership', siteScope: 'HQ', notes: 'Final HR approvals' },
  { id: 'desig_hoa', code: 'HOA', departmentCode: 'FIN', title: 'Head Accountant', level: 5, step: 1, grade: 'G4-G5', seniority: 'leadership', siteScope: 'HQ', notes: 'Finance + procurement paperwork support' },
  { id: 'desig_hro', code: 'HRO', departmentCode: 'HR', title: 'HR Officer', level: 3, step: 1, grade: 'G3-G4', seniority: 'mid', siteScope: 'HQ', notes: 'Day-to-day HR' },
  { id: 'desig_adm', code: 'ADM', departmentCode: 'ADM', title: 'Admin / Office Assistant', level: 2, step: 1, grade: 'G1-G2', seniority: 'entry', siteScope: 'HQ', notes: 'Filing and front desk' },
  { id: 'desig_bm', code: 'BM', departmentCode: 'BRANCH', title: 'Branch Manager', level: 5, step: 1, grade: 'G4-G5', seniority: 'leadership', siteScope: 'Branch', notes: 'Full branch authority' },
  { id: 'desig_abm', code: 'ABM', departmentCode: 'BRANCH', title: 'Assistant Branch Manager', level: 4, step: 1, grade: 'G3-G4', seniority: 'senior', siteScope: 'Branch', notes: 'BM backup' },
  { id: 'desig_actbm', code: 'ACTBM', departmentCode: 'BRANCH', title: 'Acting Branch Manager', level: 4, step: 1, grade: 'G3-G5', seniority: 'senior', siteScope: 'Branch', notes: 'Temporary cover only' },
  { id: 'desig_so', code: 'SO', departmentCode: 'SALES', title: 'Sales Officer', level: 3, step: 1, grade: 'G2-G3', seniority: 'mid', siteScope: 'Branch', notes: 'Quotations and customers' },
  { id: 'desig_sa', code: 'SA', departmentCode: 'SALES', title: 'Sales Assistant', level: 2, step: 1, grade: 'G1-G2', seniority: 'entry', siteScope: 'Branch', notes: 'Draft quotes — no price exception' },
  { id: 'desig_sso', code: 'SSO', departmentCode: 'SALES', title: 'Senior Sales Officer', level: 4, step: 1, grade: 'G3-G4', seniority: 'senior', siteScope: 'Branch', notes: 'Lead sales when no ABM' },
  { id: 'desig_st', code: 'ST', departmentCode: 'SALES', title: 'Sales Trainee', level: 1, step: 1, grade: 'G1', seniority: 'entry', siteScope: 'Branch', notes: 'Shadowing only' },
  { id: 'desig_sk', code: 'SK', departmentCode: 'OPS', title: 'Store Keeper / Operations Officer', level: 3, step: 1, grade: 'G2-G3', seniority: 'mid', siteScope: 'Branch', notes: 'Stock and GRN' },
  { id: 'desig_ask', code: 'ASK', departmentCode: 'OPS', title: 'Assistant Store Keeper', level: 2, step: 1, grade: 'G1-G2', seniority: 'entry', siteScope: 'Branch', notes: 'Receiving help' },
  { id: 'desig_ps', code: 'PS', departmentCode: 'OPS', title: 'Production Supervisor', level: 3, step: 1, grade: 'G2-G3', seniority: 'mid', siteScope: 'Branch', notes: 'Cutting and machines' },
  { id: 'desig_op', code: 'OP', departmentCode: 'OPS', title: 'Machine Operator', level: 2, step: 1, grade: 'G1-G2', seniority: 'entry', siteScope: 'Branch', notes: 'Production floor' },
  { id: 'desig_fa', code: 'FA', departmentCode: 'OPS', title: 'Factory Assistant', level: 1, step: 1, grade: 'G1', seniority: 'entry', siteScope: 'Branch', notes: 'Helpers' },
  { id: 'desig_ssk', code: 'SSK', departmentCode: 'OPS', title: 'Senior Store Keeper', level: 4, step: 1, grade: 'G3-G4', seniority: 'senior', siteScope: 'Branch', notes: 'Store + light production coord' },
  { id: 'desig_actsk', code: 'ACTSK', departmentCode: 'OPS', title: 'Acting Store Keeper', level: 2, step: 1, grade: 'G2-G3', seniority: 'mid', siteScope: 'Branch', notes: 'Temporary cover only' },
  { id: 'desig_csh', code: 'CSH', departmentCode: 'FIN', title: 'Cashier', level: 3, step: 1, grade: 'G2-G3', seniority: 'mid', siteScope: 'Branch', notes: 'Receipts and approved payouts' },
  { id: 'desig_acsh', code: 'ACSH', departmentCode: 'FIN', title: 'Assistant Cashier', level: 2, step: 1, grade: 'G1-G2', seniority: 'entry', siteScope: 'Branch', notes: 'Till support' },
  { id: 'desig_bac', code: 'BAC', departmentCode: 'FIN', title: 'Branch Accountant', level: 4, step: 1, grade: 'G3-G4', seniority: 'senior', siteScope: 'Branch', notes: 'Larger branch only' },
  { id: 'desig_drv', code: 'DRV', departmentCode: 'ADM', title: 'Driver', level: 2, step: 1, grade: 'G1-G2', seniority: 'entry', siteScope: 'All', notes: 'Deliveries' },
  { id: 'desig_sec', code: 'SEC', departmentCode: 'ADM', title: 'Security Guard', level: 1, step: 1, grade: 'G1', seniority: 'entry', siteScope: 'All', notes: 'Gate and watch' },
  { id: 'desig_cln', code: 'CLN', departmentCode: 'ADM', title: 'Cleaner', level: 1, step: 1, grade: 'G1', seniority: 'entry', siteScope: 'All', notes: 'Premises cleaning' },
  { id: 'desig_po', code: 'PO', departmentCode: 'PROC', title: 'Procurement Officer', level: 3, step: 1, grade: 'G2-G3', seniority: 'mid', siteScope: 'HQ', notes: 'PO processing and vendor follow-up' },
  { id: 'desig_mm', code: 'MM', departmentCode: 'MAINT', title: 'Maintenance Manager', level: 4, step: 1, grade: 'G3-G4', seniority: 'senior', siteScope: 'Branch', notes: 'Plant and premises upkeep' },
  { id: 'desig_dbm', code: 'DBM', departmentCode: 'BRANCH', title: 'Deputy Branch Manager', level: 4, step: 1, grade: 'G3-G4', seniority: 'senior', siteScope: 'Branch', notes: 'Second-in-command at branch' },
  { id: 'desig_cso', code: 'CSO', departmentCode: 'SALES', title: 'Customer Service Officer', level: 3, step: 1, grade: 'G2-G3', seniority: 'mid', siteScope: 'Branch', notes: 'Customer enquiries and order follow-up' },
];

const MATRIX_LEVELS = [
  { level: 1, label: 'Cleaners / Security / Factory Workers', base: 150_000, housing: 0, transport: 0 },
  { level: 2, label: 'Supervisors / Store / Operators', base: 250_000, housing: 40_000, transport: 20_000 },
  { level: 3, label: 'Marketers / Estimators / Officers', base: 300_000, housing: 40_000, transport: 20_000 },
  { level: 4, label: 'Senior Officers / Assistant BM', base: 380_000, housing: 50_000, transport: 25_000 },
  { level: 5, label: 'Branch Managers / Head Accountant', base: 450_000, housing: 60_000, transport: 30_000 },
  { level: 6, label: 'Senior Managers / GM HR', base: 550_000, housing: 80_000, transport: 35_000 },
  { level: 7, label: 'Executive Directors / MD', base: 700_000, housing: 100_000, transport: 40_000 },
];

const PAYROLL_MATRIX_GROUPS = ['branch_ops', 'hq_admin', 'mining_div', 'scholarship', 'chairman_staffs'];

/** Per-group multiplier on branch baseline matrix (base/housing/transport). */
export const PAYROLL_MATRIX_GROUP_SCALES = {
  branch_ops: { scale: 1, label: 'Branch operations baseline' },
  hq_admin: { scale: 1, label: 'HQ admin (same baseline as branch)' },
  mining_div: { scale: 1.1, label: 'Mining division hardship uplift (+10%)' },
  scholarship: { scale: 0.65, label: 'Scholarship stipend band (65% of branch)' },
  chairman_staffs: { scale: 0.75, label: 'Chairman domestic staff band (75% of branch)' },
};

/**
 * Idempotent seed of Zarewa org standard catalog.
 * @param {import('better-sqlite3').Database} db
 */
export function seedZarewaOrgStandard(db) {
  if (!hrMasterDataTablesReady(db)) return { ok: false, error: 'HR master data tables missing.' };
  const now = nowIso();
  let departmentsUpserted = 0;
  let designationsUpserted = 0;
  let matrixUpserted = 0;

  const insDept = db.prepare(
    `INSERT INTO hr_departments (id, name, code, branch_scope, head_user_id, description, active, created_at_iso, updated_at_iso, created_by_user_id, updated_by_user_id)
     VALUES (@id, @name, @code, @branch_scope, NULL, @description, 1, @now, @now, NULL, NULL)
     ON CONFLICT(id) DO UPDATE SET
       name=excluded.name, code=excluded.code, branch_scope=excluded.branch_scope,
       description=excluded.description, active=1, updated_at_iso=excluded.updated_at_iso`
  );

  for (const d of DEPARTMENTS) {
    insDept.run({
      id: d.id,
      name: d.name,
      code: d.code,
      branch_scope: d.branchScope,
      description: d.description,
      now,
    });
    departmentsUpserted += 1;
  }

  const deptByCode = Object.fromEntries(DEPARTMENTS.map((d) => [d.code, d.id]));

  const insDes = db.prepare(
    `INSERT INTO hr_designations (id, title, department_id, grade_category, seniority_band, default_salary_level, default_salary_step,
      job_description, duties_responsibilities, reporting_line, required_qualification, skills_required, working_conditions,
      salary_range_note, active, created_at_iso, updated_at_iso, created_by_user_id, updated_by_user_id)
     VALUES (@id, @title, @department_id, @grade_category, @seniority_band, @default_salary_level, @default_salary_step,
      @job_description, NULL, NULL, NULL, NULL, NULL, @salary_range_note, 1, @now, @now, NULL, NULL)
     ON CONFLICT(id) DO UPDATE SET
       title=excluded.title, department_id=excluded.department_id, grade_category=excluded.grade_category,
       seniority_band=excluded.seniority_band, default_salary_level=excluded.default_salary_level,
       default_salary_step=excluded.default_salary_step, job_description=excluded.job_description,
       salary_range_note=excluded.salary_range_note, active=1, updated_at_iso=excluded.updated_at_iso`
  );

  for (const d of DESIGNATIONS) {
    insDes.run({
      id: d.id,
      title: d.title,
      department_id: deptByCode[d.departmentCode] || null,
      grade_category: d.grade,
      seniority_band: d.seniority,
      default_salary_level: d.level,
      default_salary_step: d.step,
      job_description: d.notes,
      salary_range_note: `Site: ${d.siteScope}. Code: ${d.code}.`,
      now,
    });
    designationsUpserted += 1;
  }

  if (salaryMatrixReady(db)) {
    const STEP_SCALE = {
      1: { base: 1, housing: 1, transport: 1 },
      2: { base: 1.08, housing: 1.05, transport: 1 },
      3: { base: 1.15, housing: 1.1, transport: 1 },
    };
    const insMx = db.prepare(
      `INSERT INTO hr_salary_matrix (id, payroll_group, salary_level, salary_step, base_salary_ngn, housing_allowance_ngn, transport_allowance_ngn, notes, updated_at_iso, updated_by_user_id)
       VALUES (@id, @payrollGroup, @level, @step, @base, @housing, @transport, @notes, @now, NULL)
       ON CONFLICT(payroll_group, salary_level, salary_step) DO UPDATE SET
         base_salary_ngn=excluded.base_salary_ngn, housing_allowance_ngn=excluded.housing_allowance_ngn,
         transport_allowance_ngn=excluded.transport_allowance_ngn, notes=excluded.notes, updated_at_iso=excluded.updated_at_iso`
    );
    for (const payrollGroup of PAYROLL_MATRIX_GROUPS) {
      const groupScale = PAYROLL_MATRIX_GROUP_SCALES[payrollGroup]?.scale ?? 1;
      const groupLabel = PAYROLL_MATRIX_GROUP_SCALES[payrollGroup]?.label || payrollGroup;
      for (const r of MATRIX_LEVELS) {
        for (const step of [1, 2, 3]) {
          const scale = STEP_SCALE[step];
          insMx.run({
            id: `hrmx_${payrollGroup}_L${r.level}_S${step}`,
            payrollGroup,
            level: r.level,
            step,
            base: Math.round(r.base * scale.base * groupScale),
            housing: Math.round(r.housing * scale.housing * groupScale),
            transport: Math.round(r.transport * scale.transport * groupScale),
            notes: `${groupLabel} · ${r.label} — step ${step}`,
            now,
          });
          matrixUpserted += 1;
        }
      }
    }
  }

  return {
    ok: true,
    departmentsUpserted,
    designationsUpserted,
    matrixUpserted,
  };
}

export function getZarewaOrgCatalogMeta() {
  return {
    departments: DEPARTMENTS.length,
    designations: DESIGNATIONS.length,
    matrixLevels: MATRIX_LEVELS.length,
    matrixSteps: 3,
    matrixPayrollGroups: PAYROLL_MATRIX_GROUPS,
    matrixPayrollGroupScales: PAYROLL_MATRIX_GROUP_SCALES,
    functionalOffices: HR_FUNCTIONAL_OFFICES,
    designationOfficeKeys: DESIGNATION_OFFICE_KEYS,
    directorCorporateDesignationIds: [...DIRECTOR_CORPORATE_DESIGNATION_IDS],
    docPath: 'docs/HR/ZAREWA-ORG-STRUCTURE-AND-TITLES.md',
  };
}
