/**
 * In-memory MySQL integration: HR payroll save points (create → recompute → approve → lock).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createDatabase } from './db.js';
import { createApp } from './app.js';
import { isMysqlAvailableForTests } from './testIntegrationHarness.js';
import { hrReviewRequest } from './hrOps.js';

const mysqlOk = isMysqlAvailableForTests();

describe.skipIf(!mysqlOk)('HR payroll flow (integration)', () => {
  let db;
  let app;
  let agent;

  beforeEach(async () => {
    db = createDatabase(':memory:');
    app = createApp(db);
    agent = request.agent(app);
    const login = await agent.post('/api/session/login').send({ username: 'admin', password: 'Admin@123' });
    expect(login.status).toBe(200);
    expect(login.body.ok).toBe(true);
  });

  afterEach(() => {
    db?.close();
  });

  it('GET /api/hr/health reports ready', async () => {
    const res = await agent.get('/api/hr/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('payroll run lifecycle: create (auto-recompute), gm approve, lock', async () => {
    const period = '202606';
    const created = await agent.post('/api/hr/payroll-runs').send({
      periodYyyymm: period,
    });
    expect(created.status).toBe(201);
    expect(created.body.ok).toBe(true);
    expect(created.body.autoRecomputed).toBe(true);
    const runId = created.body.id;
    expect(runId).toBeTruthy();

    const lines = await agent.get(`/api/hr/payroll-runs/${runId}/lines`);
    expect(lines.status).toBe(200);
    expect(lines.body.ok).toBe(true);
    expect(Array.isArray(lines.body.lines)).toBe(true);

    const totals = await agent.get(`/api/hr/payroll-runs/${runId}/totals`);
    expect(totals.status).toBe(200);
    expect(totals.body.ok).toBe(true);
    expect(totals.body.totals?.headcount).toBeGreaterThanOrEqual(0);

    const gm = await agent.post(`/api/hr/payroll-runs/${runId}/gm-approve`);
    expect(gm.status).toBe(200);
    expect(gm.body.ok).toBe(true);

    const locked = await agent.patch(`/api/hr/payroll-runs/${runId}`).send({ status: 'locked' });
    expect(locked.status).toBe(200);
    expect(locked.body.ok).toBe(true);

    const pdf = await agent.get(`/api/hr/payroll-runs/${runId}/export/payslips-pdf`);
    expect(pdf.status).toBe(200);
    expect(String(pdf.headers['content-type'] || '')).toContain('application/pdf');
    const pdfBuf = Buffer.isBuffer(pdf.body) ? pdf.body : Buffer.from(pdf.text || '');
    expect(pdfBuf.slice(0, 5).toString('ascii')).toBe('%PDF-');

    const run = await agent.get(`/api/hr/payroll-runs/${runId}`);
    expect(run.status).toBe(200);
    expect(run.body.run.status).toBe('locked');
  });

  it('rejects a second payroll run for the same calendar month', async () => {
    const period = '202607';
    const first = await agent.post('/api/hr/payroll-runs').send({ periodYyyymm: period });
    expect(first.status).toBe(201);
    expect(first.body.ok).toBe(true);

    const second = await agent.post('/api/hr/payroll-runs').send({ periodYyyymm: period });
    expect(second.status).toBe(400);
    expect(second.body.ok).toBe(false);
    expect(String(second.body.error || '')).toMatch(/already exists/i);
  });

  it('GET /api/hr/policy-config returns pension defaults', async () => {
    const res = await agent.get('/api/hr/policy-config');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.policy?.pensionEmployeePercent).toBe(8);
    expect(res.body.policy?.pensionEmployerPercent).toBe(10);
  });

  it('salary matrix and branch contributions endpoints', async () => {
    const matrix = await agent.get('/api/hr/salary-matrix');
    expect(matrix.status).toBe(200);
    expect(matrix.body.ok).toBe(true);

    const put = await agent.put('/api/hr/salary-matrix').send({
      payrollGroup: 'branch_ops',
      salaryLevel: 3,
      salaryStep: 1,
      baseSalaryNgn: 150000,
      housingAllowanceNgn: 10000,
      transportAllowanceNgn: 5000,
    });
    expect(put.status).toBe(200);
    expect(put.body.ok).toBe(true);

    const contrib = await agent.get('/api/hr/branch-contributions?periodYyyymm=202606');
    expect(contrib.status).toBe(200);
    expect(contrib.body.ok).toBe(true);
    expect(Array.isArray(contrib.body.contributions)).toBe(true);
  });

  it('hrReviewRequest requires reasonCode and note', () => {
    const staff = db.prepare(`SELECT id FROM app_users WHERE username = 'sales.staff' LIMIT 1`).get();
    const userId = staff?.id || db.prepare(`SELECT id FROM app_users LIMIT 1`).get()?.id;
    expect(userId).toBeTruthy();
    const actor = { id: 'USR-TEST', displayName: 'Test', permissions: ['*'] };
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO hr_requests (id, user_id, branch_id, kind, status, title, created_at_iso)
       VALUES ('HRR-TEST', ?, 'BR-KD', 'leave', 'hr_review', 'Test leave', ?)`
    ).run(userId, now);
    const bad = hrReviewRequest(db, 'HRR-TEST', actor, true, 'ok', '');
    expect(bad.ok).toBe(false);
    const good = hrReviewRequest(db, 'HRR-TEST', actor, true, 'Approved for annual leave', 'policy');
    expect(good.ok).toBe(true);
  });
});
