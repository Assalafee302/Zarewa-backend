import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createDatabase } from './db.js';
import { createApp } from './app.js';

function mysqlAvailable() {
  try {
    const db = createDatabase(':memory:', { seed: false });
    db.close();
    return true;
  } catch {
    return false;
  }
}

const mysqlOk = mysqlAvailable();

describe.skipIf(!mysqlOk).sequential('Business intelligence API', () => {
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

  it('GET /api/analytics/business-intelligence returns full pack', async () => {
    const res = await agent.get('/api/analytics/business-intelligence?period=month');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.inventory?.families?.length).toBe(2);
    expect(res.body.sales).toBeTruthy();
    expect(res.body.predictive).toBeTruthy();
    expect(Array.isArray(res.body.predictive.alerts)).toBe(true);
  });

  it('supports period query variants', async () => {
    for (const period of ['month', '4months', 'half', 'year']) {
      const res = await agent.get(`/api/analytics/business-intelligence?period=${period}`);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.periodKey).toBe(period);
    }
  });

  it('returns 401 when not signed in', async () => {
    const res = await request(app).get('/api/analytics/business-intelligence');
    expect(res.status).toBe(401);
  });
});
