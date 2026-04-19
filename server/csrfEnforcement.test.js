import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createDatabase } from './db.js';
import { createApp } from './app.js';

function parseCookieValue(setCookieHeaders, name) {
  const list = Array.isArray(setCookieHeaders) ? setCookieHeaders : [];
  const row = list.find((c) => String(c).startsWith(`${name}=`));
  if (!row) return '';
  return String(row).slice(`${name}=`.length).split(';')[0];
}

describe('CSRF enforcement', () => {
  let db;
  let app;
  let originalNodeEnv;
  let originalEnforce;

  beforeEach(() => {
    originalNodeEnv = process.env.NODE_ENV;
    originalEnforce = process.env.ZAREWA_TEST_ENFORCE_CSRF;
    process.env.NODE_ENV = 'test';
    process.env.ZAREWA_TEST_ENFORCE_CSRF = '1';
    db = createDatabase(':memory:');
    app = createApp(db);
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    process.env.ZAREWA_TEST_ENFORCE_CSRF = originalEnforce;
    db?.close();
    db = undefined;
    app = undefined;
  });

  it('rejects POST without X-CSRF-Token even when authenticated', async () => {
    const agent = request.agent(app);
    const login = await agent.post('/api/session/login').send({ username: 'admin', password: 'Admin@123' });
    expect(login.status).toBe(200);

    const create = await agent.post('/api/customers').send({
      customerID: 'CUS-CSRF-01',
      name: 'CSRF Customer',
      phoneNumber: '08000000001',
      email: 'csrf01@example.com',
      addressShipping: 'S',
      addressBilling: 'B',
      status: 'Active',
      tier: 'Retail',
      paymentTerms: 'Cash',
    });
    expect(create.status).toBe(403);
    expect(create.body.code).toBe('CSRF_INVALID');
  });

  it('accepts POST when X-CSRF-Token matches csrf cookie', async () => {
    const agent = request.agent(app);
    const login = await agent.post('/api/session/login').send({ username: 'admin', password: 'Admin@123' });
    expect(login.status).toBe(200);

    const csrf = parseCookieValue(login.headers['set-cookie'], 'zarewa_csrf');
    expect(csrf).toBeTruthy();

    const create = await agent
      .post('/api/customers')
      .set('X-CSRF-Token', csrf)
      .send({
        customerID: 'CUS-CSRF-02',
        name: 'CSRF OK',
        phoneNumber: '08000000002',
        email: 'csrf02@example.com',
        addressShipping: 'S',
        addressBilling: 'B',
        status: 'Active',
        tier: 'Retail',
        paymentTerms: 'Cash',
      });
    expect(create.status).toBe(201);
  });
});

