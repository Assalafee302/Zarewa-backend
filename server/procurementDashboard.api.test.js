import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createDatabase } from './db.js';
import { createApp } from './app.js';

describe.sequential('Procurement dashboard analytics API', () => {
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

  it('returns procurement dashboard endpoints', async () => {
    const endpoints = [
      '/api/procurement/dashboard/summary',
      '/api/procurement/dashboard/spend-trend',
      '/api/procurement/dashboard/supplier-scorecard',
      '/api/procurement/dashboard/payables-aging',
      '/api/procurement/dashboard/coil-risk',
      '/api/procurement/dashboard/alerts',
    ];
    for (const ep of endpoints) {
      const res = await agent.get(ep);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    }
  });
});

