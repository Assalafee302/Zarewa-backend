import { describe, expect, it, beforeEach, afterEach } from 'vitest';
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

describe.skipIf(!mysqlOk)('mobile auth API', () => {
  let app;
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
    app = createApp(db);
  });

  afterEach(() => {
    db?.close?.();
  });

  it('logs in with mobile tokens and loads session + home', async () => {
    const agent = request(app);

    const login = await agent.post('/api/mobile/auth/login').send({
      username: 'admin',
      password: 'Admin@123',
      deviceName: 'Test Phone',
      platform: 'android',
    });

    expect(login.status).toBe(200);
    expect(login.body.ok).toBe(true);
    expect(login.body.accessToken).toBeTruthy();
    expect(login.body.refreshToken).toBeTruthy();
    expect(login.body.user?.username).toBe('admin');

    const session = await agent
      .get('/api/mobile/session')
      .set('Authorization', `Bearer ${login.body.accessToken}`);
    expect(session.status).toBe(200);
    expect(session.body.authenticated).toBe(true);

    const home = await agent
      .get('/api/mobile/home')
      .set('Authorization', `Bearer ${login.body.accessToken}`);
    expect(home.status).toBe(200);
    expect(home.body.ok).toBe(true);
    expect(Array.isArray(home.body.tabs)).toBe(true);
    expect(home.body.counts).toBeTruthy();

    const approvals = await agent
      .get('/api/mobile/approvals')
      .set('Authorization', `Bearer ${login.body.accessToken}`);
    expect(approvals.status).toBe(200);
    expect(approvals.body.ok).toBe(true);
    expect(Array.isArray(approvals.body.items)).toBe(true);

    const quotes = await agent
      .get('/api/mobile/quotes')
      .set('Authorization', `Bearer ${login.body.accessToken}`);
    expect(quotes.status).toBe(200);
    expect(quotes.body.ok).toBe(true);
    expect(Array.isArray(quotes.body.quotations)).toBe(true);

    const refresh = await agent.post('/api/mobile/auth/refresh').send({
      refreshToken: login.body.refreshToken,
    });
    expect(refresh.status).toBe(200);
    expect(refresh.body.accessToken).toBeTruthy();

    const logout = await agent
      .post('/api/mobile/auth/logout')
      .set('Authorization', `Bearer ${refresh.body.accessToken}`);
    expect(logout.status).toBe(200);
    expect(logout.body.ok).toBe(true);
  });
});
