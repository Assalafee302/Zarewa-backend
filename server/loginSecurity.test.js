import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createDatabase } from './db.js';
import { createApp } from './app.js';
import {
  FAILED_LOGIN_LOCK_THRESHOLD,
  ACCOUNT_LOCK_MINUTES,
  SESSION_WARNING_SECONDS,
  loginWithPassword,
  sessionTimeoutMinutes,
  validatePasswordStrength,
  resolveRegisteredPasswordDisplay,
} from './auth.js';
import { buildLoginSecuritySummary, listActiveSessions } from './sessionSecurityOps.js';

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

describe('Phase 12 login security (pure)', () => {
  it('validatePasswordStrength enforces complexity rules', () => {
    expect(validatePasswordStrength('short').ok).toBe(false);
    expect(validatePasswordStrength('NoDigit!').ok).toBe(false);
    expect(validatePasswordStrength('GoodPass1!').ok).toBe(true);
  });

  it('sessionTimeoutMinutes defaults to 15 and respects env', () => {
    const prev = process.env.SESSION_TIMEOUT_MINUTES;
    delete process.env.SESSION_TIMEOUT_MINUTES;
    expect(sessionTimeoutMinutes()).toBe(15);
    process.env.SESSION_TIMEOUT_MINUTES = '30';
    expect(sessionTimeoutMinutes()).toBe(30);
    process.env.SESSION_TIMEOUT_MINUTES = '3';
    expect(sessionTimeoutMinutes()).toBe(15);
    if (prev === undefined) delete process.env.SESSION_TIMEOUT_MINUTES;
    else process.env.SESSION_TIMEOUT_MINUTES = prev;
  });

  it('resolveRegisteredPasswordDisplay never returns plaintext', () => {
    expect(
      resolveRegisteredPasswordDisplay(null, {
        username: 'admin',
        registered_password: 'Secret@123',
        password_hash: 'x:y',
      })
    ).toBe('');
  });

  it('lockout constants match Phase 12 spec', () => {
    expect(FAILED_LOGIN_LOCK_THRESHOLD).toBe(5);
    expect(ACCOUNT_LOCK_MINUTES).toBe(30);
    expect(SESSION_WARNING_SECONDS).toBe(60);
  });
});

describe.skipIf(!mysqlOk)('Phase 12 login security (HTTP)', () => {
  let app;
  let db;
  let agent;

  beforeEach(() => {
    db = createDatabase(':memory:');
    app = createApp(db);
    agent = request.agent(app);
  });

  afterEach(() => {
    db?.close();
  });

  it('login returns session expiry metadata', async () => {
    const res = await agent.post('/api/session/login').send({ username: 'admin', password: 'Admin@123' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.sessionExpiresAtIso).toBeTruthy();
    expect(res.body.sessionTimeoutMinutes).toBe(sessionTimeoutMinutes());
    expect(res.body.sessionWarningSeconds).toBe(SESSION_WARNING_SECONDS);
  });

  it(`locks account after ${FAILED_LOGIN_LOCK_THRESHOLD} failed attempts`, async () => {
    for (let i = 0; i < FAILED_LOGIN_LOCK_THRESHOLD; i++) {
      const res = await agent.post('/api/session/login').send({ username: 'admin', password: 'wrong' });
      expect([401, 423]).toContain(res.status);
    }
    const locked = await agent.post('/api/session/login').send({ username: 'admin', password: 'wrong' });
    expect(locked.status).toBe(423);
    expect(locked.body.code).toBe('ACCOUNT_LOCKED');

    const direct = loginWithPassword(db, 'admin', 'Admin@123');
    expect(direct.ok).toBe(false);
    expect(direct.code).toBe('ACCOUNT_LOCKED');
  });

  it('records failed login audits', async () => {
    await agent.post('/api/session/login').send({ username: 'admin', password: 'bad' });
    const summary = buildLoginSecuritySummary(db, { hours: 1 });
    expect(summary.failedLoginAttempts).toBeGreaterThanOrEqual(1);
  });

  it('POST /api/session/firebase is removed', async () => {
    const res = await request(app).post('/api/session/firebase').send({ idToken: 'x' });
    expect(res.status).toBe(404);
  });

  it('POST /api/session/timeout clears session', async () => {
    await agent.post('/api/session/login').send({ username: 'admin', password: 'Admin@123' });
    expect(listActiveSessions(db).length).toBeGreaterThan(0);

    const timeout = await agent.post('/api/session/timeout').send({});
    expect(timeout.status).toBe(200);
    expect(timeout.body.code).toBe('SESSION_TIMEOUT');

    const bootstrap = await agent.get('/api/bootstrap');
    expect(bootstrap.status).toBe(401);
  });

  it('admin security APIs return data for admin', async () => {
    await agent.post('/api/session/login').send({ username: 'admin', password: 'Admin@123' });

    const summary = await agent.get('/api/admin/security/login-summary');
    expect(summary.status).toBe(200);
    expect(summary.body.ok).toBe(true);
    expect(summary.body).toHaveProperty('failedLoginAttempts');

    const sessions = await agent.get('/api/admin/security/active-sessions');
    expect(sessions.status).toBe(200);
    expect(Array.isArray(sessions.body.sessions)).toBe(true);
  });

  it('team users list omits registered passwords', async () => {
    await agent.post('/api/session/login').send({ username: 'admin', password: 'Admin@123' });
    const res = await agent.get('/api/bootstrap');
    expect(res.status).toBe(200);
    for (const u of res.body.appUsers || []) {
      expect(u.registeredPassword || '').toBe('');
    }
  });
});
