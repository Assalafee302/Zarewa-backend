import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createDatabase } from './db.js';
import { createApp } from './app.js';
import { isMysqlAvailableForTests } from './testIntegrationHarness.js';

const mysqlOk = isMysqlAvailableForTests();

describe.skipIf(!mysqlOk)('accounting finance security', () => {
  let app;
  let agent;
  let db;

  async function loginAs(client, username = 'admin', password = 'Admin@123') {
    const res = await client.post('/api/session/login').send({ username, password });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    return res;
  }

  beforeEach(async () => {
    db = createDatabase(':memory:');
    app = createApp(db);
    agent = request.agent(app);
    await loginAs(agent);
  });

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it('POST /api/gl/journal replays identical Idempotency-Key without duplicate journal', async () => {
    const key = 'test_gl_journal_idem_001';
    const body = {
      entryDateISO: '2031-03-10',
      memo: 'Idempotency vitest',
      lines: [
        { accountCode: '6100', debitNgn: 5000, memo: 'debit' },
        { accountCode: '1000', creditNgn: 5000, memo: 'credit' },
      ],
    };
    const first = await agent
      .post('/api/gl/journal')
      .set('Idempotency-Key', key)
      .send(body);
    expect(first.status).toBe(201);
    expect(first.body.ok).toBe(true);
    expect(first.body.journalId).toBeTruthy();

    const second = await agent
      .post('/api/gl/journal')
      .set('Idempotency-Key', key)
      .send(body);
    expect(second.status).toBe(201);
    expect(second.body.journalId).toBe(first.body.journalId);

    const count = db
      .prepare(`SELECT COUNT(*) AS n FROM gl_journal_entries WHERE source_kind = 'MANUAL_JOURNAL'`)
      .get();
    expect(Number(count?.n)).toBe(1);
  });

  it('POST /api/gl/journal writes audit log row', async () => {
    const res = await agent.post('/api/gl/journal').set('Idempotency-Key', 'audit_gl_001').send({
      entryDateISO: '2031-03-11',
      memo: 'Audit trail vitest',
      lines: [
        { accountCode: '6100', debitNgn: 1200 },
        { accountCode: '1000', creditNgn: 1200 },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    const row = db
      .prepare(
        `SELECT action, entity_id FROM audit_log WHERE action = 'gl.manual_journal' ORDER BY occurred_at_iso DESC LIMIT 1`
      )
      .get();
    expect(row?.action).toBe('gl.manual_journal');
    expect(String(row?.entity_id || '')).toBe(String(res.body.journalId || ''));
  });

  it('POST /api/admin/data-reset requires settings.manage', async () => {
    const salesAgent = request.agent(app);
    await loginAs(salesAgent, 'sales.staff', 'Sales@123');
    const res = await salesAgent.post('/api/admin/data-reset').send({
      presetIds: ['document_sequences'],
      confirmPhrase: 'RESET SELECTED DATA',
    });
    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);
  });

  it('GET /api/gl/activity returns truncated flag when capped', async () => {
    const res = await agent.get('/api/gl/activity?startDate=2030-01-01&endDate=2030-12-31');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.truncated).toBe('boolean');
    expect(typeof res.body.limit).toBe('number');
  });

  it('GET /api/customers/:id/summary scopes queries to one customer', async () => {
    const bootstrap = await agent.get('/api/bootstrap');
    expect(bootstrap.status).toBe(200);
    const cid = bootstrap.body.customers?.[0]?.customerID;
    if (!cid) return;
    const res = await agent.get(`/api/customers/${encodeURIComponent(cid)}/summary`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.customerId).toBe(cid);
    expect(Array.isArray(res.body.outstandingByQuotation)).toBe(true);
  });
});
