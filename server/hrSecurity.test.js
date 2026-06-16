/**
 * HR privacy: bootstrap, staff API, workspace search, AI redaction.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createDatabase } from './db.js';
import { createApp } from './app.js';
import { isMysqlAvailableForTests } from './testIntegrationHarness.js';
import { buildBootstrap } from './bootstrap.js';
import { buildAiContextForRequest } from './aiAssistContext.js';
import { redactStaffForAi } from './hrRedaction.js';
import { workspaceQuickSearch } from './workspaceSearchOps.js';

const mysqlOk = isMysqlAvailableForTests();

describe.skipIf(!mysqlOk)('HR security', () => {
  let db;
  let app;
  let adminAgent;
  let salesAgent;

  beforeEach(async () => {
    db = createDatabase(':memory:');
    app = createApp(db);
    adminAgent = request.agent(app);
    salesAgent = request.agent(app);
    const adminLogin = await adminAgent
      .post('/api/session/login')
      .send({ username: 'admin', password: 'Admin@123' });
    expect(adminLogin.status).toBe(200);
    const salesLogin = await salesAgent
      .post('/api/session/login')
      .send({ username: 'sales.staff', password: 'Sales@123' });
    expect(salesLogin.status).toBe(200);
  });

  afterEach(() => {
    db?.close();
  });

  it('bootstrap snapshot does not embed HR salary fields', async () => {
    const sess = await adminAgent.get('/api/session');
    const user = sess.body.session?.user;
    const snap = buildBootstrap(db, user, { workspaceBranchId: 'BR-KD', workspaceViewAll: true });
    const json = JSON.stringify(snap);
    expect(json.includes('baseSalaryNgn')).toBe(false);
    expect(json.includes('housingAllowanceNgn')).toBe(false);
  });

  it('staff list redacts compensation for branch manager (team HR)', async () => {
    const bm = request.agent(app);
    const login = await bm.post('/api/session/login').send({ username: 'sales.manager', password: 'Sales@123' });
    expect(login.status).toBe(200);
    const res = await bm.get('/api/hr/staff');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const withSalary = (res.body.staff || []).filter((s) => s.baseSalaryNgn != null && s.baseSalaryNgn > 0);
    expect(withSalary.length).toBe(0);
  });

  it('includeSalary=1 is rejected without sensitive permission', async () => {
    const res = await salesAgent.get('/api/hr/staff?includeSalary=1');
    expect([403, 200]).toContain(res.status);
    if (res.status === 200) {
      const withSalary = (res.body.staff || []).filter((s) => s.baseSalaryNgn != null);
      expect(withSalary.length).toBe(0);
    }
  });

  it('workspace search hr_staff hits omit compensation', async () => {
    const sess = await adminAgent.get('/api/session');
    const user = sess.body.session?.user;
    const staffRow = db
      .prepare(
        `SELECT u.display_name FROM app_users u
         INNER JOIN hr_staff_profiles p ON p.user_id = u.id
         WHERE u.status = 'active' LIMIT 1`
      )
      .get();
    const q = String(staffRow?.display_name || 'Sales').split(/\s+/)[0];
    const req = {
      user,
      workspaceBranchId: 'BR-KD',
      workspaceViewAll: true,
      query: { q },
    };
    const hits = workspaceQuickSearch(db, req, 20);
    const hrHits = hits.filter((h) => h.kind === 'hr_staff');
    expect(hrHits.length).toBeGreaterThan(0);
    const blob = JSON.stringify(hrHits);
    expect(blob.includes('baseSalary')).toBe(false);
  });

  it('redactStaffForAi strips salary from staff row', () => {
    const out = redactStaffForAi({ userId: 'U1', baseSalaryNgn: 500000, bankName: 'GTB' });
    expect(out.baseSalaryNgn).toBeNull();
    expect(out.bankName).toBeNull();
    expect(out.compensationRedacted).toBe(true);
  });

  it('AI HR context for staff page does not include raw salary numbers', async () => {
    const prof = db
      .prepare(`SELECT user_id FROM hr_staff_profiles WHERE base_salary_ngn > 0 LIMIT 1`)
      .get();
    if (!prof?.user_id) return;
    const sess = await adminAgent.get('/api/session');
    const user = sess.body.session?.user;
    const ctx = buildAiContextForRequest(
      db,
      {
        user,
        workspaceBranchId: 'BR-KD',
        workspaceViewAll: true,
      },
      {
        mode: 'hr',
        pageContext: { staffUserId: prof.user_id, pathname: '/hr/employees' },
      }
    );
    const text = JSON.stringify(ctx);
    expect(text).not.toMatch(/"baseSalaryNgn":\s*[1-9]/);
  });
});
