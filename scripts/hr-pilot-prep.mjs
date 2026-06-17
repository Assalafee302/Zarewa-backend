#!/usr/bin/env node
/**
 * Pilot prep: inspect and fix seeded HR staff for UAT (A), readiness (B), payroll pilot (C).
 *   node scripts/hr-pilot-prep.mjs           # inspect only
 *   node scripts/hr-pilot-prep.mjs --apply   # apply fixes + payroll pilot
 */
process.env.ZAREWA_MYSQL_HOST = process.env.ZAREWA_MYSQL_HOST || '127.0.0.1';
process.env.ZAREWA_MYSQL_PORT = process.env.ZAREWA_MYSQL_PORT || '3306';
process.env.ZAREWA_MYSQL_USER = process.env.ZAREWA_MYSQL_USER || 'root';
if (process.env.ZAREWA_MYSQL_PASSWORD === undefined) process.env.ZAREWA_MYSQL_PASSWORD = '';
process.env.ZAREWA_MYSQL_DATABASE = process.env.ZAREWA_MYSQL_DATABASE || 'zarewa_db';

import { openConfiguredMysql } from '../server/cliMysql.js';
import { buildHrReadiness } from '../server/hrModuleHealth.js';
import { getHrOperationalReadiness } from '../server/hrOperationalReadiness.js';
import { canUseAllBranchesRollup } from '../server/auth.js';
import {
  acceptHrPolicy,
  approvePayrollRunByGmHr,
  approvePayrollRunByMd,
  computePayrollRun,
  createPayrollRun,
  hasHrPolicyAcceptance,
  patchPayrollRun,
  recomputeHrLeaveBalances,
  upsertHrStaffProfile,
} from '../server/hrOps.js';
import { enforcePortalOnlyRole, HR_PORTAL_ONLY_ROLE_KEY } from '../server/hrStaffAccessPolicy.js';
import { isErpAccessRestrictedPayrollGroup } from '../shared/lib/hrStaffCohorts.js';
import { HR_POLICY_REGISTRY } from '../server/hrPolicy.js';

const POLICY_VERSION = Object.fromEntries(HR_POLICY_REGISTRY.map((p) => [p.key, p.version]));

const apply = process.argv.includes('--apply');
const adminUser = { id: 'USR-ADMIN', roleKey: 'admin', permissions: ['*'] };
const scope = {
  viewAll: canUseAllBranchesRollup(adminUser),
  branchId: 'BR-HQ',
  scopeMode: 'org',
  actorUserId: adminUser.id,
};

/** Per demo account — keeps ERP roles where needed; portal-only for scholarship/mining/domestic demos. */
const STAFF_PLAN = {
  'USR-ADMIN': {
    departmentId: 'dept_adm',
    designationId: 'desig_adm',
    payrollGroup: 'hq_admin',
    branchId: 'BR-HQ',
    salaryLevel: 6,
    salaryStep: 1,
    baseSalaryNgn: 500_000,
    keepRole: true,
  },
  'USR-MD': {
    departmentId: 'dept_exec',
    designationId: 'desig_md',
    payrollGroup: 'hq_admin',
    branchId: 'BR-HQ',
    salaryLevel: 6,
    salaryStep: 2,
    baseSalaryNgn: 600_000,
    keepRole: true,
  },
  'USR-CEO': {
    departmentId: 'dept_exec',
    jobTitle: 'Chief Executive Officer',
    payrollGroup: 'hq_admin',
    branchId: 'BR-HQ',
    salaryLevel: 6,
    salaryStep: 1,
    baseSalaryNgn: 550_000,
    keepRole: true,
  },
  'USR-FIN': {
    departmentId: 'dept_fin',
    designationId: 'desig_hoa',
    payrollGroup: 'branch_ops',
    branchId: 'BR-KD',
    salaryLevel: 5,
    salaryStep: 2,
    baseSalaryNgn: 380_000,
    keepRole: true,
  },
  'USR-SM': {
    departmentId: 'dept_sales',
    designationId: 'desig_bm',
    payrollGroup: 'branch_ops',
    branchId: 'BR-KD',
    salaryLevel: 4,
    salaryStep: 1,
    baseSalaryNgn: 280_000,
    keepRole: true,
  },
  'USR-OPS': {
    departmentId: 'dept_ops',
    designationId: 'desig_sk',
    payrollGroup: 'hq_admin',
    branchId: 'BR-HQ',
    salaryLevel: 4,
    salaryStep: 1,
    baseSalaryNgn: 240_000,
    keepRole: true,
  },
  'USR-SS': {
    departmentId: 'dept_sales',
    designationId: 'desig_so',
    payrollGroup: 'branch_ops',
    branchId: 'BR-KD',
    salaryLevel: 3,
    salaryStep: 1,
    baseSalaryNgn: 180_000,
    keepRole: true,
  },
  'USR-VIEW': {
    departmentId: 'dept_exec',
    jobTitle: 'Scholarship Beneficiary',
    payrollGroup: 'scholarship',
    branchId: 'BR-HQ',
    salaryLevel: 1,
    salaryStep: 1,
    baseSalaryNgn: 75_000,
    portalOnly: true,
  },
  'USR-CASH': {
    departmentId: 'dept_adm',
    jobTitle: 'Domestic Staff',
    payrollGroup: 'chairman_staffs',
    branchId: 'BR-HQ',
    salaryLevel: 1,
    salaryStep: 1,
    baseSalaryNgn: 70_000,
    portalOnly: true,
  },
};

function pilotBank(displayName, idx) {
  const acct = String(2000000000 + idx).slice(-10);
  return {
    bankName: 'Access Bank',
    bankCode: '044',
    bankAccountNo: acct,
    bankAccountName: String(displayName || `Pilot Staff ${idx}`).trim(),
  };
}

/** @param {import('better-sqlite3').Database} db */
function listStaffRows(db) {
  return db
    .prepare(
      `SELECT u.id AS userId, u.username, u.display_name AS displayName, u.role_key AS roleKey,
              p.employee_no AS employeeNo, p.department, p.payroll_group AS payrollGroup,
              p.salary_level AS salaryLevel, p.salary_step AS salaryStep,
              p.base_salary_ngn AS baseSalaryNgn, p.bank_name AS bankName,
              p.bank_account_no_masked AS bankMasked, p.onboarding_complete AS onboardingComplete
       FROM app_users u
       LEFT JOIN hr_staff_profiles p ON p.user_id = u.id
       WHERE u.status = 'active'
       ORDER BY u.display_name ASC`
    )
    .all();
}

function applyPlan(db, staffRows) {
  const results = [];
  let idx = 0;
  for (const row of staffRows) {
    idx += 1;
    const plan = STAFF_PLAN[row.userId];
    if (!plan) {
      results.push({ userId: row.userId, ok: false, error: 'No pilot plan for user.' });
      continue;
    }
    const body = {
      userId: row.userId,
      employeeNo: row.employeeNo || `EMP-${row.userId.replace('USR-', '')}`,
      departmentId: plan.departmentId,
      designationId: plan.designationId,
      jobTitle: plan.jobTitle,
      branchId: plan.branchId,
      payrollGroup: plan.payrollGroup,
      employmentType: 'permanent',
      dateJoinedIso: row.dateJoinedIso || '2024-01-15',
      salaryLevel: plan.salaryLevel,
      salaryStep: plan.salaryStep,
      baseSalaryNgn: plan.baseSalaryNgn,
      housingAllowanceNgn: Math.round(plan.baseSalaryNgn * 0.1),
      transportAllowanceNgn: Math.round(plan.baseSalaryNgn * 0.05),
      selfServiceEligible: true,
      ...pilotBank(row.displayName, idx),
    };

    const r = upsertHrStaffProfile(db, adminUser.id, body);
    if (!r.ok) {
      results.push({ userId: row.userId, displayName: row.displayName, ok: false, error: r.error });
      continue;
    }

    db.prepare(`UPDATE hr_staff_profiles SET onboarding_complete = 1, updated_at_iso = ? WHERE user_id = ?`).run(
      new Date().toISOString(),
      row.userId
    );

    const now = new Date().toISOString();
    for (const policyKey of ['employee_handbook', 'confidentiality_pledge']) {
      const version = POLICY_VERSION[policyKey];
      if (!hasHrPolicyAcceptance(db, row.userId, policyKey, version)) {
        const ack = acceptHrPolicy(db, { ...adminUser, displayName: row.displayName }, {
          userId: row.userId,
          policyKey,
          policyVersion: version,
          signatureName: row.displayName,
        });
        if (!ack.ok) {
          results.push({ userId: row.userId, displayName: row.displayName, ok: false, error: ack.error });
          continue;
        }
      }
    }

    const docId = `HSD-PILOT-${row.userId}`;
    const existingDoc = db.prepare(`SELECT id FROM hr_staff_documents WHERE id = ?`).get(docId);
    if (!existingDoc) {
      db.prepare(
        `INSERT INTO hr_staff_documents (id, user_id, doc_kind, file_name, mime_type, data_b64, uploaded_at_iso, uploaded_by_user_id)
         VALUES (?, ?, 'nin_slip', 'pilot-nin.pdf', 'application/pdf', ?, ?, ?)`
      ).run(docId, row.userId, Buffer.from('pilot').toString('base64'), now, adminUser.id);
    }

    let roleKey = row.roleKey;
    if (plan.portalOnly || isErpAccessRestrictedPayrollGroup(plan.payrollGroup)) {
      enforcePortalOnlyRole(db, row.userId, plan.payrollGroup);
      roleKey = HR_PORTAL_ONLY_ROLE_KEY;
    } else if (plan.keepRole) {
      if (row.roleKey === HR_PORTAL_ONLY_ROLE_KEY && !isErpAccessRestrictedPayrollGroup(plan.payrollGroup)) {
        db.prepare(`UPDATE app_users SET role_key = ?, permissions_json = NULL, department = ? WHERE id = ?`).run(
          'sales_staff',
          'sales_staff',
          row.userId
        );
        roleKey = 'sales_staff';
      }
    }

    results.push({
      userId: row.userId,
      displayName: row.displayName,
      ok: true,
      department: plan.departmentId || plan.department,
      payrollGroup: plan.payrollGroup,
      roleKey: db.prepare(`SELECT role_key FROM app_users WHERE id = ?`).get(row.userId)?.role_key,
      portalOnly: Boolean(plan.portalOnly),
    });
  }

  recomputeHrLeaveBalances(db, adminUser, { year: new Date().getFullYear() });
  return results;
}

function runPayrollPilot(db) {
  const periodYyyymm = new Date().toISOString().slice(0, 7).replace('-', '');
  let runId = db
    .prepare(`SELECT id FROM hr_payroll_runs WHERE period_yyyymm = ? ORDER BY created_at_iso DESC LIMIT 1`)
    .get(periodYyyymm)?.id;
  let created = false;

  if (!runId) {
    const c = createPayrollRun(db, adminUser, { periodYyyymm, notes: 'Pilot run — UAT prep script' });
    if (!c.ok) return c;
    runId = c.id;
    created = true;
  } else {
    const st = db.prepare(`SELECT status FROM hr_payroll_runs WHERE id = ?`).get(runId)?.status;
    if (st === 'draft') computePayrollRun(db, runId);
  }

  const gm = approvePayrollRunByGmHr(db, runId, adminUser);
  const md = approvePayrollRunByMd(db, runId, adminUser);
  const lock = patchPayrollRun(db, runId, { status: 'locked' }, adminUser);
  const run = db.prepare(`SELECT id, period_yyyymm, status FROM hr_payroll_runs WHERE id = ?`).get(runId);
  const lineCount = db.prepare(`SELECT COUNT(*) AS c FROM hr_payroll_lines WHERE run_id = ?`).get(runId)?.c || 0;
  const totals = db
    .prepare(`SELECT SUM(net_ngn) AS net, SUM(gross_ngn) AS gross FROM hr_payroll_lines WHERE run_id = ?`)
    .get(runId);

  return {
    ok: true,
    created,
    runId,
    periodYyyymm,
    status: run?.status,
    lineCount,
    grossNgn: totals?.gross || 0,
    netNgn: totals?.net || 0,
    gmApprove: gm.ok,
    mdApprove: md.ok,
    locked: lock.ok,
    lockError: lock.ok ? null : lock.error,
  };
}

const { db, label } = openConfiguredMysql({ migrate: false });
const before = listStaffRows(db);
console.log(JSON.stringify({ phase: 'before', database: label(), staffCount: before.length }, null, 2));

if (apply) {
  const fixes = applyPlan(db, before);
  const after = listStaffRows(db);
  const readiness = buildHrReadiness(db, scope);
  const operational = getHrOperationalReadiness(db, scope);
  const payroll = runPayrollPilot(db);
  console.log(
    JSON.stringify(
      {
        phase: 'after',
        fixes,
        readiness: {
          productionReady: readiness.productionReady,
          canCutover: readiness.canCutover,
          blockers: readiness.blockers,
          gates: readiness.gates,
        },
        operational: {
          readyForOperations: operational.readyForOperations,
          totalIssues: operational.totalIssues,
          openChecks: (operational.checks || []).filter((c) => c.count > 0).map((c) => ({
            id: c.id,
            count: c.count,
          })),
        },
        payrollPilot: payroll,
      },
      null,
      2
    )
  );
} else {
  console.log(JSON.stringify({ staff: before }, null, 2));
  console.log('\nDry run — pass --apply to fix staff, recompute leave, and create payroll pilot run.');
}

db.close();
