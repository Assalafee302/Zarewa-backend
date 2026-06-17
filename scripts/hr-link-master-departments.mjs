#!/usr/bin/env node
/**
 * Link legacy free-text hr_staff_profiles.department values to hr_departments master data.
 *
 *   node scripts/hr-link-master-departments.mjs           # dry run
 *   node scripts/hr-link-master-departments.mjs --apply   # update profiles
 */
process.env.ZAREWA_MYSQL_HOST = process.env.ZAREWA_MYSQL_HOST || '127.0.0.1';
process.env.ZAREWA_MYSQL_PORT = process.env.ZAREWA_MYSQL_PORT || '3306';
process.env.ZAREWA_MYSQL_USER = process.env.ZAREWA_MYSQL_USER || 'root';
if (process.env.ZAREWA_MYSQL_PASSWORD === undefined) process.env.ZAREWA_MYSQL_PASSWORD = '';
process.env.ZAREWA_MYSQL_DATABASE = process.env.ZAREWA_MYSQL_DATABASE || 'zarewa_db';

import { openConfiguredMysql } from '../server/cliMysql.js';
import { seedZarewaOrgStandard } from '../server/hrOrgSeed.js';
import { getHrDepartment, getHrDesignation } from '../server/hrMasterData.js';
import { upsertHrStaffProfile } from '../server/hrOps.js';

const apply = process.argv.includes('--apply');
const adminActor = 'USR-ADMIN';

/** @param {string} legacy */
function legacyKey(legacy) {
  return String(legacy || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** Fallback when role-specific mapping is not enough. */
const LEGACY_TEXT_TO_DEPT = {
  'hq administration': 'dept_adm',
  'finance kaduna': 'dept_fin',
  'sales kaduna': 'dept_sales',
  'mining division': 'dept_ops',
  'chairman domestic staff': 'dept_adm',
  'executive family scholarship': 'dept_exec',
};

/** Preferred master link from app role + payroll cohort. */
const ROLE_MASTER = {
  admin: { departmentId: 'dept_adm', designationId: 'desig_adm' },
  md: { departmentId: 'dept_exec', designationId: 'desig_md' },
  ceo: { departmentId: 'dept_exec', designationId: null, jobTitle: 'Chief Executive Officer' },
  finance_manager: { departmentId: 'dept_fin', designationId: 'desig_hoa' },
  sales_manager: { departmentId: 'dept_sales', designationId: 'desig_bm' },
  sales_staff: { departmentId: 'dept_sales', designationId: 'desig_so' },
  cashier: { departmentId: 'dept_fin', designationId: 'desig_csh' },
  operations_officer: { departmentId: 'dept_ops', designationId: 'desig_sk' },
  hr_admin: { departmentId: 'dept_hr', designationId: 'desig_hro' },
  gmhr: { departmentId: 'dept_hr', designationId: 'desig_gmhr' },
};

/** @param {{ roleKey: string; department: string; payrollGroup: string }} row */
function resolveMasterLink(row) {
  const pg = String(row.payrollGroup || '').trim();
  const legacy = legacyKey(row.department);
  const roleKey = String(row.roleKey || '').trim();

  if (pg === 'scholarship' || legacy.includes('scholarship')) {
    return {
      departmentId: 'dept_exec',
      designationId: null,
      jobTitle: 'Scholarship Beneficiary',
      reason: 'scholarship cohort → Executive',
    };
  }
  if (pg === 'chairman_staffs' || legacy.includes('domestic')) {
    return {
      departmentId: 'dept_adm',
      designationId: null,
      jobTitle: 'Domestic Staff',
      reason: 'domestic cohort → Administration',
    };
  }

  const byRole = ROLE_MASTER[roleKey];
  if (byRole) {
    return { ...byRole, jobTitle: byRole.jobTitle ?? null, reason: `role ${roleKey}` };
  }

  if (pg === 'mining_div' || legacy.includes('mining')) {
    return {
      departmentId: 'dept_ops',
      designationId: 'desig_op',
      jobTitle: null,
      reason: 'mining payroll group → Operations & Production',
    };
  }

  const departmentId = LEGACY_TEXT_TO_DEPT[legacy];
  if (departmentId) {
    return { departmentId, designationId: null, jobTitle: null, reason: `legacy text "${row.department}"` };
  }

  return { departmentId: null, designationId: null, jobTitle: null, reason: 'unmapped' };
}

function listStaff(db) {
  return db
    .prepare(
      `SELECT u.id AS userId, u.username, u.role_key AS roleKey,
              p.department, p.department_id AS departmentId, p.designation_id AS designationId,
              p.job_title AS jobTitle, p.payroll_group AS payrollGroup
       FROM app_users u
       INNER JOIN hr_staff_profiles p ON p.user_id = u.id
       WHERE u.status = 'active'
       ORDER BY u.username`
    )
    .all();
}

function planRow(row) {
  const link = resolveMasterLink(row);
  const dept = link.departmentId ? getHrDepartment(dbRef, link.departmentId) : null;
  const des = link.designationId ? getHrDesignation(dbRef, link.designationId) : null;
  const alreadyLinked =
    row.departmentId === link.departmentId &&
    (link.designationId ? row.designationId === link.designationId : true) &&
    (!dept?.name || row.department === dept.name);

  return {
    userId: row.userId,
    username: row.username,
    roleKey: row.roleKey,
    before: {
      department: row.department,
      departmentId: row.departmentId,
      designationId: row.designationId,
      jobTitle: row.jobTitle,
    },
    after: {
      department: dept?.name || row.department,
      departmentId: link.departmentId,
      designationId: link.designationId,
      jobTitle: link.jobTitle || des?.title || row.jobTitle,
    },
    reason: link.reason,
    skip: !link.departmentId || alreadyLinked,
  };
}

let dbRef;
const { db, label } = openConfiguredMysql({ migrate: false });
dbRef = db;

const seed = seedZarewaOrgStandard(db);
const staff = listStaff(db);
const plans = staff.map(planRow);
const toApply = plans.filter((p) => !p.skip);

console.log(
  JSON.stringify(
    {
      phase: apply ? 'apply' : 'dry-run',
      database: label(),
      orgSeed: { departments: seed?.departments, designations: seed?.designations },
      staffCount: staff.length,
      needsUpdate: toApply.length,
      plans,
    },
    null,
    2
  )
);

if (apply && toApply.length) {
  const results = [];
  for (const p of toApply) {
    const body = {
      userId: p.userId,
      departmentId: p.after.departmentId,
      designationId: p.after.designationId || undefined,
    };
    if (p.after.jobTitle && p.after.jobTitle !== p.before.jobTitle) {
      body.jobTitle = p.after.jobTitle;
    }
    const r = upsertHrStaffProfile(db, adminActor, body);
    results.push({
      userId: p.userId,
      username: p.username,
      ok: r.ok,
      error: r.error || null,
      linked: p.after,
    });
  }
  console.log(JSON.stringify({ applied: results }, null, 2));
} else if (!apply && toApply.length) {
  console.log('\nDry run — pass --apply to link departments to master catalog.');
}

db.close();
