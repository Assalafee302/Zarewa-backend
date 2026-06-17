#!/usr/bin/env node
/**
 * HR UAT smoke test — exercises core workflows against the configured MySQL database.
 *
 *   node scripts/hr-uat-smoke.mjs
 */
process.env.ZAREWA_MYSQL_HOST = process.env.ZAREWA_MYSQL_HOST || '127.0.0.1';
process.env.ZAREWA_MYSQL_PORT = process.env.ZAREWA_MYSQL_PORT || '3306';
process.env.ZAREWA_MYSQL_USER = process.env.ZAREWA_MYSQL_USER || 'root';
if (process.env.ZAREWA_MYSQL_PASSWORD === undefined) process.env.ZAREWA_MYSQL_PASSWORD = '';
process.env.ZAREWA_MYSQL_DATABASE = process.env.ZAREWA_MYSQL_DATABASE || 'zarewa_db';
process.env.NODE_ENV = 'test';

import request from 'supertest';
import { createApp } from '../server/app.js';
import { openConfiguredMysql } from '../server/cliMysql.js';
import { recomputeHrLeaveBalances, acceptHrPolicy, hasHrPolicyAcceptance } from '../server/hrOps.js';
import { HR_POLICY_REGISTRY } from '../server/hrPolicy.js';

const { db, label } = openConfiguredMysql({ migrate: false });
const app = createApp(db);

// Demo accounts should not block self-service workflows during UAT.
db.prepare(`UPDATE app_users SET must_change_password = 0 WHERE status = 'active'`).run();

const results = [];

function record(name, pass, detail = '') {
  results.push({ name, pass, detail });
  const mark = pass ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ''}`);
}

async function login(agent, username, password) {
  const res = await agent.post('/api/session/login').send({ username, password });
  return res.status === 200 && res.body?.ok === true;
}

function ensurePolicyAcks(userId, policyKeys) {
  const actor = { id: 'USR-ADMIN', displayName: 'Zarewa Admin' };
  for (const policyKey of policyKeys) {
    const reg = HR_POLICY_REGISTRY.find((p) => p.key === policyKey);
    if (!reg) continue;
    if (hasHrPolicyAcceptance(db, userId, policyKey, reg.version)) continue;
    acceptHrPolicy(db, actor, {
      userId,
      policyKey,
      policyVersion: reg.version,
      signatureName: 'Zarewa Admin',
    });
  }
}

function futureIso(daysAhead) {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  return d.toISOString().slice(0, 10);
}

try {
  recomputeHrLeaveBalances(db, { id: 'USR-ADMIN' }, { year: new Date().getFullYear() });
  ensurePolicyAcks('USR-ADMIN', ['employee_handbook', 'code_of_conduct', 'eeo_policy', 'confidentiality_pledge']);
  ensurePolicyAcks('USR-SM', ['employee_handbook', 'confidentiality_pledge']);

  // 1. Health + readiness
  const admin = request.agent(app);
  if (!(await login(admin, 'admin', 'Admin@123'))) {
    record('Admin login', false, 'credentials rejected');
  } else {
    record('Admin login', true);

    const health = await admin.get('/api/hr/health');
    const ready = health.body?.productionReady === true || health.body?.hrReady === true;
    record('HR health endpoint', health.status === 200 && ready, `productionReady=${health.body?.productionReady ?? health.body?.hrReady}`);

    const dash = await admin.get('/api/hr/dashboard');
    const canCutover = dash.body?.readiness?.canCutover === true;
    record('HR dashboard readiness', dash.status === 200 && canCutover, `canCutover=${dash.body?.readiness?.canCutover}`);

    const staff = await admin.get('/api/hr/staff');
    const linked = (staff.body?.staff || []).filter((s) => s.departmentId).length;
    record('Staff directory loads', staff.status === 200 && linked > 0, `${linked} staff with linked departments`);

    const period = new Date().toISOString().slice(0, 7).replace('-', '');
    const runs = await admin.get('/api/hr/payroll-runs');
    const hasRun = (runs.body?.runs || []).some((r) => String(r.periodYyyymm) === period);
    record('Payroll runs list', runs.status === 200 && hasRun, hasRun ? `period ${period} present` : 'no current period run');
  }

  // 2. Employee self-service
  const staffAgent = request.agent(app);
  if (!(await login(staffAgent, 'sales.staff', 'Sales@123'))) {
    record('Sales staff login', false);
  } else {
    record('Sales staff login', true);

    const me = await staffAgent.get('/api/hr/me');
    const hrDept = me.body?.hr?.department || '';
    record(
      'My Profile HR record',
      me.status === 200 && me.body?.ok && /sales/i.test(hrDept),
      `department="${hrDept}"`
    );

    const balances = await staffAgent.get('/api/hr/leave/balances');
    record('Leave balances', balances.status === 200 && balances.body?.ok, `${(balances.body?.balances || []).length} balance row(s)`);

    const payslips = await staffAgent.get('/api/hr/payslips');
    record('Payslips self-service', payslips.status === 200 && payslips.body?.ok, `${(payslips.body?.payslips || []).length} payslip(s)`);

    const dir = await staffAgent.get('/api/hr/staff');
    if (dir.status === 403) {
      record('Salary redaction (staff list)', true, 'no directory access (expected)');
    } else {
      const exposed = (dir.body?.staff || []).filter((s) => s.baseSalaryNgn != null && Number(s.baseSalaryNgn) > 0);
      record('Salary redaction (staff list)', exposed.length === 0, exposed.length ? `${exposed.length} exposed` : 'compensation hidden');
    }
  }

  // 3. Leave workflow end-to-end
  {
    const employee = request.agent(app);
    await login(employee, 'sales.staff', 'Sales@123');
    const start = futureIso(30);
    const created = await employee.post('/api/hr/requests').send({
      kind: 'leave',
      title: 'UAT smoke — annual leave',
      body: 'Automated UAT smoke test',
      payload: {
        leaveType: 'annual',
        startDateIso: start,
        endDateIso: start,
        daysRequested: 1,
        handoverTo: 'Sales Manager',
      },
    });
    const requestId = created.body?.request?.id || created.body?.id;
    record('Leave request draft', created.status === 201 && created.body?.ok, requestId || created.body?.error);

    if (requestId) {
      const submitted = await employee.patch(`/api/hr/requests/${requestId}/submit`);
      record('Leave submit', submitted.status === 200 && submitted.body?.ok, submitted.body?.status || submitted.body?.error);

      const hrAdmin = request.agent(app);
      await login(hrAdmin, 'admin', 'Admin@123');
      const hrReview = await hrAdmin.patch(`/api/hr/requests/${requestId}/hr-review`).send({
        approve: true,
        note: 'UAT HR review',
        reasonCode: 'policy',
      });
      record('Leave HR review', hrReview.status === 200 && hrReview.body?.ok, hrReview.body?.status || hrReview.body?.error);

      const bm = request.agent(app);
      await login(bm, 'sales.manager', 'Sales@123');
      const endorse = await bm.patch(`/api/hr/requests/${requestId}/branch-endorse`).send({
        approve: true,
        note: 'UAT branch endorsement',
        reasonCode: 'policy',
      });
      record('Leave branch endorsement', endorse.status === 200 && endorse.body?.ok, endorse.body?.status || endorse.body?.error);

      const gm = request.agent(app);
      await login(gm, 'admin', 'Admin@123');
      const gmReview = await gm.patch(`/api/hr/requests/${requestId}/gm-hr-review`).send({
        approve: true,
        note: 'UAT GM HR approval',
        reasonCode: 'policy',
      });
      record('Leave GM HR approval', gmReview.status === 200 && gmReview.body?.ok, gmReview.body?.status || gmReview.body?.error);
    }
  }

  // 4. Public careers (no auth)
  {
    const careers = await request(app).get('/api/public/careers/jobs');
    record('Public careers API', careers.status === 200 && careers.body?.ok !== false, `${(careers.body?.jobs || []).length} job(s)`);
  }

  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass);
  console.log('\n---');
  console.log(`HR UAT smoke: ${passed}/${results.length} passed (${label()})`);
  if (failed.length) {
    console.log('Failed:');
    for (const f of failed) console.log(`  - ${f.name}: ${f.detail}`);
    process.exitCode = 1;
  }
} catch (e) {
  console.error('Smoke test crashed:', e?.message || e);
  process.exitCode = 1;
} finally {
  db.close();
}
