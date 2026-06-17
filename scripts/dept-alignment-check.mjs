#!/usr/bin/env node
process.env.ZAREWA_MYSQL_PASSWORD = process.env.ZAREWA_MYSQL_PASSWORD ?? '';
import { openConfiguredMysql } from '../server/cliMysql.js';
import { roleLabel } from '../server/auth.js';

const WORKSPACE_LABELS = {
  admin: 'Administrator',
  md: 'Managing director',
  finance_manager: 'Finance manager',
  sales_manager: 'Branch manager',
  sales_staff: 'Sales officer',
  cashier: 'Cashier',
  operations_officer: 'Operations officer / Store keeper',
  hr_admin: 'HR / Admin',
  gmhr: 'GM HR',
  hr_portal_only: 'HR portal only',
  ceo: 'CEO',
};

const { db } = openConfiguredMysql({ migrate: false });

const rows = db
  .prepare(
    `SELECT u.id, u.username, u.role_key AS roleKey, u.department AS workspaceDept,
            p.department AS hrDepartment, p.department_id AS hrDepartmentId,
            p.job_title AS jobTitle, p.payroll_group AS payrollGroup
     FROM app_users u
     LEFT JOIN hr_staff_profiles p ON p.user_id = u.id
     WHERE u.status = 'active'
     ORDER BY u.username`
  )
  .all();

const depts = db.prepare('SELECT id, code, name FROM hr_departments').all();
const deptById = Object.fromEntries(depts.map((d) => [d.id, d]));

const ROLE_TO_HR_HINTS = {
  admin: ['Administration', 'Executive', 'HQ'],
  md: ['Executive', 'HQ'],
  ceo: ['Executive', 'HQ'],
  finance_manager: ['Finance'],
  cashier: ['Finance', 'Cashier'],
  sales_manager: ['Branch', 'Sales'],
  sales_staff: ['Sales'],
  operations_officer: ['Operations', 'Store', 'Production', 'Mining'],
  hr_admin: ['Human Resources', 'HR'],
  gmhr: ['Human Resources', 'HR'],
};

const LOOSE = {
  finance_manager: /finance|account|cashier/i,
  sales_manager: /sales|branch/i,
  sales_staff: /sales/i,
  operations_officer: /ops|store|production|mining|operations/i,
  md: /exec|hq|admin|managing/i,
  admin: /admin|hq|exec|it/i,
  ceo: /exec|hq|admin/i,
  cashier: /finance|cashier/i,
};

function assess(row) {
  const wsLabel = WORKSPACE_LABELS[row.workspaceDept] || row.workspaceDept || roleLabel(row.roleKey);
  const hrDept = row.hrDepartment || '(none)';
  const masterName = row.hrDepartmentId ? deptById[row.hrDepartmentId]?.name : null;
  const rk = row.roleKey;
  const pg = String(row.payrollGroup || '');

  if (pg === 'chairman_staffs' || pg === 'scholarship' || pg === 'domestic' || pg === 'mining') {
    const portalOk = rk === 'hr_portal_only';
    return {
      verdict: portalOk ? 'OK_SPECIAL' : 'REVIEW',
      reason: portalOk
        ? `Special payroll group (${pg}) — HR portal role is correct`
        : `Special payroll group (${pg}) but ERP role is ${rk} — may need hr_portal_only`,
    };
  }

  const hints = ROLE_TO_HR_HINTS[rk];
  if (!hints) return { verdict: 'UNKNOWN_ROLE', reason: `No mapping rule for role ${rk}` };

  const hay = `${hrDept} ${masterName || ''} ${row.jobTitle || ''}`.toLowerCase();
  if (hints.some((h) => hay.includes(h.toLowerCase()))) {
    return { verdict: 'ALIGNED', reason: `HR dept matches expected area for ${wsLabel}` };
  }
  if (LOOSE[rk]?.test(hay)) {
    return { verdict: 'ALIGNED', reason: 'HR dept loosely matches role (legacy import naming)' };
  }
  return { verdict: 'MISMATCH', reason: `Workspace role ${wsLabel} but HR dept is "${hrDept}"` };
}

const users = rows.map((r) => {
  const a = assess(r);
  return {
    username: r.username,
    roleKey: r.roleKey,
    roleLabel: roleLabel(r.roleKey),
    workspaceDept: r.workspaceDept,
    workspaceLabel: WORKSPACE_LABELS[r.workspaceDept] || r.workspaceDept,
    hrDepartment: r.hrDepartment,
    hrDepartmentMaster: r.hrDepartmentId ? deptById[r.hrDepartmentId]?.name : null,
    hrDepartmentLinked: Boolean(r.hrDepartmentId),
    jobTitle: r.jobTitle,
    payrollGroup: r.payrollGroup,
    ...a,
  };
});

const counts = users.reduce((acc, u) => {
  acc[u.verdict] = (acc[u.verdict] || 0) + 1;
  return acc;
}, {});

console.log(
  JSON.stringify(
    {
      summary: counts,
      masterDepartments: depts,
      note:
        'Profile shows workspaceDept (app role). HR page shows hrDepartment (org unit). They are different fields.',
      users,
    },
    null,
    2
  )
);

db.close();
