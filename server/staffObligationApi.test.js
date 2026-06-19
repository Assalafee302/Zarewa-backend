import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { acquireIntegrationHarness, isMysqlAvailableForTests } from './testIntegrationHarness.js';
import { migrateLegacyStaffLoan } from './staffObligationOps.js';

describe.skipIf(!isMysqlAvailableForTests())('staffObligationApi', () => {
  let app;
  let db;
  let staffUserId;
  let staffCookie;

  beforeAll(async () => {
    const harness = acquireIntegrationHarness();
    app = harness.app;
    db = harness.db;
    const staff = db.prepare(`SELECT user_id FROM hr_staff_profiles LIMIT 1`).get();
    staffUserId = staff?.user_id;
    expect(staffUserId).toBeTruthy();

    const user = db.prepare(`SELECT username FROM app_users WHERE id = ?`).get(staffUserId);
    const login = await request(app)
      .post('/api/session/login')
      .send({ username: user?.username || 'sales.staff', password: 'Staff@123' });
    if (login.status !== 200) {
      const adminLogin = await request(app).post('/api/session/login').send({ username: 'admin', password: 'Admin@123' });
      staffCookie = adminLogin.headers['set-cookie'];
    } else {
      staffCookie = login.headers['set-cookie'];
    }
  });

  it('allows self-service money-summary for staff profile user', async () => {
    const res = await request(app)
      .get(`/api/hr/staff/${encodeURIComponent(staffUserId)}/money-summary`)
      .set('Cookie', staffCookie);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body).toHaveProperty('totalOutstandingNgn');
    expect(res.body).toHaveProperty('purchaseEligibility');
    expect(res.body).toHaveProperty('staffBranchId');
  });

  it('lists obligation accounts scoped to user when userId query is set', async () => {
    migrateLegacyStaffLoan(db, { id: 'admin' }, {
      userId: staffUserId,
      principalOriginalNgn: 50_000,
      amountRepaidNgn: 0,
      installmentNgn: 10_000,
      termMonths: 5,
      title: 'API test legacy loan',
    });
    const res = await request(app)
      .get(`/api/hr/obligation-accounts?userId=${encodeURIComponent(staffUserId)}&kind=loan`)
      .set('Cookie', staffCookie);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.accounts)).toBe(true);
    expect(res.body.accounts.length).toBeGreaterThanOrEqual(1);
    expect(res.body.accounts.every((a) => a.userId === staffUserId)).toBe(true);
  });
});
