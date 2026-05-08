import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createDatabase } from './db.js';
import { createApp } from './app.js';

describe.sequential('Sales dashboard analytics API', () => {
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

  it('returns sales dashboard endpoints', async () => {
    const endpoints = [
      '/api/sales/dashboard/summary',
      '/api/sales/dashboard/revenue-trend',
      '/api/sales/dashboard/receivables-aging',
      '/api/sales/dashboard/top-customers',
      '/api/sales/dashboard/demand-mix',
      '/api/sales/dashboard/alerts',
    ];
    for (const ep of endpoints) {
      const res = await agent.get(ep);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    }
  });
});

