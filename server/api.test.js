import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createDatabase } from './db.js';
import { createApp } from './app.js';
import { REFUND_TEST_PAYEE } from './refundTestPayee.js';

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

describe.skipIf(!mysqlOk).sequential('Zarewa API', () => {
  let app;
  let agent;
  let db;
  const savedEnv = {};

  async function loginAs(client, username = 'admin', password = 'Admin@123') {
    const res = await client.post('/api/session/login').send({ username, password });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    return res;
  }


  beforeEach(async () => {
    savedEnv.ZAREWA_AI_API_KEY = process.env.ZAREWA_AI_API_KEY;
    savedEnv.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    savedEnv.ZAREWA_AI_BASE_URL = process.env.ZAREWA_AI_BASE_URL;
    savedEnv.ZAREWA_AI_MODEL = process.env.ZAREWA_AI_MODEL;
    db = createDatabase(':memory:');
    app = createApp(db);
    agent = request.agent(app);
    await loginAs(agent);
  });

  afterEach(() => {
    for (const k of ['ZAREWA_AI_API_KEY', 'OPENAI_API_KEY', 'ZAREWA_AI_BASE_URL', 'ZAREWA_AI_MODEL']) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    vi.restoreAllMocks();
    db?.close();
    db = undefined;
  });

  it('GET /api/health', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.capabilities?.officeDesk).toBe(true);
    expect(res.body.capabilities?.accountingPolicyV1).toBe('ap1b');
    expect(res.body.capabilities?.deliveryPaymentGate).toBe('off');
    expect(res.body.capabilities?.accountingPolicyV1Labels).toBe('off');
  });

  it('GET /readyz returns minimal public liveness', async () => {
    const res = await request(app).get('/readyz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        ok: true,
        service: 'zarewa-api',
      })
    );
    expect(res.body.capabilities).toBeUndefined();
  });

  it('POST /api/ai/chat returns 503 when AI is not configured', async () => {
    const res = await agent.post('/api/ai/chat').send({ messages: [{ role: 'user', content: 'Hi' }] });
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
  });

  it('POST /api/help/chat returns built-in answer for receipt questions', async () => {
    const helpAgent = request.agent(app);
    await loginAs(helpAgent, 'sales.staff', 'Sales@123');
    const res = await helpAgent
      .post('/api/help/chat')
      .send({ message: 'How do I add a receipt?', pathname: '/sales' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.source).toBe('kb');
    expect(String(res.body.message)).toMatch(/payment|receipt/i);
    expect(Array.isArray(res.body.links)).toBe(true);
  });

  it('GET /api/ai/status reports mode access by role', async () => {
    process.env.ZAREWA_AI_API_KEY = 'test-key';
    const salesAgent = request.agent(app);
    await loginAs(salesAgent, 'sales.staff', 'Sales@123');
    const salesRes = await salesAgent.get('/api/ai/status');
    expect(salesRes.status).toBe(200);
    expect(salesRes.body.enabled).toBe(true);
    expect(salesRes.body.allowedModes).toContain('search');
    expect(salesRes.body.allowedModes).toContain('sales');
    expect(salesRes.body.allowedModes).not.toContain('finance');

    const mdAgent = request.agent(app);
    await loginAs(mdAgent, 'md', 'Md@1234567890!');
    const mdRes = await mdAgent.get('/api/ai/status');
    expect(mdRes.status).toBe(200);
    expect(mdRes.body.enabled).toBe(true);
    expect(mdRes.body.allowedModes).toContain('search');
    expect(mdRes.body.allowedModes).toContain('procurement');
    expect(mdRes.body.allowedModes).toContain('finance');
  });

  it('sales.staff can create cutting lists (quotations.manage)', async () => {
    const staff = request.agent(app);
    await loginAs(staff, 'sales.staff', 'Sales@123');
    const cutting = await staff.post('/api/cutting-lists').send({
      quotationRef: 'QT-2026-005',
      customerID: 'CUS-001',
      productID: 'FG-101',
      productName: 'Longspan thin',
      dateISO: '2026-03-29',
      machineName: 'Machine 01 (Longspan)',
      operatorName: 'Ibrahim',
      lines: [
        { sheets: 1, lengthM: 6 },
        { sheets: 1, lengthM: 4.5 },
      ],
    });
    expect(cutting.status).toBe(201);
    expect(cutting.body.id || cutting.body.cuttingList?.id).toBeTruthy();
  });

  it('POST /api/ai/chat rejects module mode without access', async () => {
    process.env.ZAREWA_AI_API_KEY = 'test-key';
    const salesAgent = request.agent(app);
    await loginAs(salesAgent, 'sales.staff', 'Sales@123');
    const res = await salesAgent.post('/api/ai/chat').send({
      messages: [{ role: 'user', content: 'Show me finance issues' }],
      mode: 'finance',
      context: 'Path: /accounts',
      pageContext: { pathname: '/accounts' },
    });
    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);
  });

  it('POST /api/ai/chat sends server-generated live context to provider', async () => {
    process.env.ZAREWA_AI_API_KEY = 'test-key';
    process.env.ZAREWA_AI_BASE_URL = 'https://api.openai.com/v1';
    process.env.ZAREWA_AI_MODEL = 'gpt-test';
    const fetchMock = vi.fn(async () => ({
      ok: true,
      text: async () =>
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'Live context summary.' } }],
        }),
    }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await agent.post('/api/ai/chat').send({
      messages: [{ role: 'user', content: 'What needs attention today?' }],
      mode: 'search',
      context: 'Path: /',
      pageContext: { pathname: '/', source: 'dashboard-test' },
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.message).toBe('Live context summary.');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(String(fetchMock.mock.calls[0][1].body || '{}'));
    expect(payload.messages[0].role).toBe('system');
    expect(String(payload.messages[0].content)).toContain('Live workspace context from the server:');
    expect(String(payload.messages[0].content)).toContain('Current notifications:');
    expect(String(payload.messages[0].content)).toContain('Client page context:');
  });

  it('GET /api/bootstrap requires authentication', async () => {
    const res = await request(app).get('/api/bootstrap');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('AUTH_REQUIRED');
  });

  it('POST /api/session/login and GET /api/bootstrap return session payload', async () => {
    const loginRes = await request(app).post('/api/session/login').send({
      username: 'admin',
      password: 'Admin@123',
    });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.user.username).toBe('admin');
    expect(loginRes.body.user.department).toBe('admin');

    const signedAgent = request.agent(app);
    await loginAs(signedAgent);
    const res = await signedAgent.get('/api/bootstrap');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.session.authenticated).toBe(true);
    expect(res.body.session.user.username).toBe('admin');
    expect(Array.isArray(res.body.customers)).toBe(true);
    expect(Array.isArray(res.body.products)).toBe(true);
    expect(Array.isArray(res.body.purchaseOrders)).toBe(true);
    expect(res.body.ledgerEntries).toBeDefined();
    expect(Array.isArray(res.body.advanceInEvents)).toBe(true);
    expect(Array.isArray(res.body.treasuryMovements)).toBe(true);
    expect(Array.isArray(res.body.productionJobs)).toBe(true);
    expect(Array.isArray(res.body.productionJobCoils)).toBe(true);
    expect(res.body.masterData).toBeDefined();
    expect(Array.isArray(res.body.masterData.quoteItems)).toBe(true);
    expect(res.body.masterData.quoteItems.length).toBeGreaterThan(0);
    expect(res.body.dashboardPrefs).toBeDefined();
    expect(typeof res.body.dashboardPrefs).toBe('object');
    expect(res.body).toHaveProperty('orgManagerTargets');
    expect(Array.isArray(res.body.workspaceDepartmentIds)).toBe(true);
    expect(res.body.workspaceDepartmentIds).toContain('sales_staff');
    expect(res.body.suggestedRoleByDepartment?.sales).toBe('sales_staff');
    expect(res.body.operationsInventoryAttention).toBeDefined();
    expect(res.body.operationsInventoryAttention.ok).toBe(true);
    expect(res.body.operationsInventoryAttention.stuckProduction).toBeDefined();
    expect(res.body.operationsInventoryAttention.inventoryChain).toBeDefined();
    expect(res.body.operationsInventoryAttention.crossModule).toBeDefined();
  });

  it('POST /api/session/firebase is removed (Phase 12)', async () => {
    const res = await request(app).post('/api/session/firebase').send({ idToken: 'x' });
    expect(res.status).toBe(404);
  });

  it('locks account after five failed login attempts', async () => {
    const lockAgent = request.agent(app);
    for (let i = 0; i < 5; i++) {
      const res = await lockAgent.post('/api/session/login').send({ username: 'admin', password: 'wrong' });
      expect([401, 423]).toContain(res.status);
    }
    const locked = await lockAgent.post('/api/session/login').send({ username: 'admin', password: 'wrong' });
    expect(locked.status).toBe(423);
    expect(locked.body.code).toBe('ACCOUNT_LOCKED');
  });

  it('GET /api/workspace/search works for managing director', async () => {
    const mdAgent = request.agent(app);
    await loginAs(mdAgent, 'md', 'Md@1234567890!');
    const res = await mdAgent.get('/api/workspace/search?q=CU');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('GET /api/workspace/search returns structured hits for admin', async () => {
    const res = await agent.get('/api/workspace/search?q=musa&limit=10');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.results)).toBe(true);
    expect(res.body.results.length).toBeGreaterThan(0);
    expect(res.body.results.some((r) => r.kind === 'customer')).toBe(true);
  });

  it('GET /api/roles returns role catalog and permission keys for settings users', async () => {
    const signedAgent = request.agent(app);
    await loginAs(signedAgent);
    const res = await signedAgent.get('/api/roles');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.roles)).toBe(true);
    expect(res.body.roles.some((r) => r.key === 'admin')).toBe(true);
    expect(Array.isArray(res.body.permissionKeys)).toBe(true);
    expect(res.body.permissionKeys.includes('dashboard.view')).toBe(true);
  });

  it('POST /api/users creates a login when admin has settings.view', async () => {
    const signedAgent = request.agent(app);
    await loginAs(signedAgent);
    const boot = await signedAgent.get('/api/bootstrap');
    const branchId = boot.body?.session?.branches?.[0]?.id || 'BR-KD';
    const res = await signedAgent.post('/api/users').send({
      username: 'e2e.created.user',
      displayName: 'E2E Created',
      password: 'TempPass@999!',
      roleKey: 'sales_staff',
      branchId,
    });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.userId).toMatch(/^USR-/);
    const loginRes = await request(app)
      .post('/api/session/login')
      .send({ username: 'e2e.created.user', password: 'TempPass@999!' });
    expect(loginRes.status).toBe(200);
    expect(loginRes.body.user?.mustChangePassword).toBe(true);
    expect(loginRes.body.user?.trainingCompleted).toBe(false);
  });

  it('DELETE /api/users/:id removes a user when confirmUsername matches (admin)', async () => {
    const signedAgent = request.agent(app);
    await loginAs(signedAgent);
    const boot = await signedAgent.get('/api/bootstrap');
    const branchId = boot.body?.session?.branches?.[0]?.id || 'BR-KD';
    const create = await signedAgent.post('/api/users').send({
      username: 'e2e.delete.me.user',
      displayName: 'E2E Delete Me',
      password: 'TempPass@999!',
      roleKey: 'sales_staff',
      branchId,
    });
    expect(create.status).toBe(201);
    const userId = create.body.userId;
    const bad = await signedAgent.delete(`/api/users/${encodeURIComponent(userId)}`).send({
      confirmUsername: 'wrong',
    });
    expect(bad.status).toBe(400);
    expect(bad.body.ok).toBe(false);
    const del = await signedAgent.delete(`/api/users/${encodeURIComponent(userId)}`).send({
      confirmUsername: 'e2e.delete.me.user',
    });
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);
    const list = await signedAgent.get('/api/users');
    expect(list.status).toBe(200);
    const still = list.body.users.some((u) => u.id === userId);
    expect(still).toBe(false);
  });

  it('PATCH /api/session/dashboard-prefs persists and returns on bootstrap', async () => {
    const signedAgent = request.agent(app);
    await loginAs(signedAgent);
    const patch = await signedAgent.patch('/api/session/dashboard-prefs').send({
      showCharts: false,
      showReportsStrip: true,
      showAlertBanner: false,
    });
    expect(patch.status).toBe(200);
    expect(patch.body.ok).toBe(true);
    expect(patch.body.dashboardPrefs.showCharts).toBe(false);
    expect(patch.body.dashboardPrefs.managerTargets).toBeDefined();
    expect(typeof patch.body.dashboardPrefs.managerTargets.nairaTargetPerMonth).toBe('number');
    expect(typeof patch.body.dashboardPrefs.managerTargets.meterTargetPerMonth).toBe('number');
    const boot = await signedAgent.get('/api/bootstrap');
    expect(boot.status).toBe(200);
    expect(boot.body.dashboardPrefs.showCharts).toBe(false);
    expect(boot.body.dashboardPrefs.showAlertBanner).toBe(false);
    expect(boot.body.dashboardPrefs.managerTargets?.nairaTargetPerMonth).toBeGreaterThan(0);
  });

  it('PATCH /api/setup/org-manager-targets persists and returns on bootstrap', async () => {
    const signedAgent = request.agent(app);
    await loginAs(signedAgent);
    const patch = await signedAgent.patch('/api/setup/org-manager-targets').send({
      nairaTargetPerMonth: 60_000_000,
      meterTargetPerMonth: 300_000,
    });
    expect(patch.status).toBe(200);
    expect(patch.body.ok).toBe(true);
    expect(patch.body.orgManagerTargets.nairaTargetPerMonth).toBe(60_000_000);
    expect(patch.body.orgManagerTargets.meterTargetPerMonth).toBe(300_000);
    const boot = await signedAgent.get('/api/bootstrap');
    expect(boot.status).toBe(200);
    expect(boot.body.orgManagerTargets?.nairaTargetPerMonth).toBe(60_000_000);
    expect(boot.body.orgManagerTargets?.meterTargetPerMonth).toBe(300_000);
    const clear = await signedAgent.patch('/api/setup/org-manager-targets').send({ clear: true });
    expect(clear.status).toBe(200);
    expect(clear.body.orgManagerTargets).toBeNull();
  });

  it('PATCH /api/session/profile updates display name and returns on bootstrap', async () => {
    const signedAgent = request.agent(app);
    await loginAs(signedAgent);
    const patch = await signedAgent.patch('/api/session/profile').send({ displayName: 'Zarewa Admin Updated' });
    expect(patch.status).toBe(200);
    expect(patch.body.ok).toBe(true);
    expect(patch.body.user.displayName).toBe('Zarewa Admin Updated');
    const boot = await signedAgent.get('/api/bootstrap');
    expect(boot.status).toBe(200);
    expect(boot.body.session.user.displayName).toBe('Zarewa Admin Updated');
  });

  it('GET /api/customers returns seeded customers', async () => {
    const res = await agent.get('/api/customers');
    expect(res.status).toBe(200);
    expect(res.body.customers.length).toBeGreaterThanOrEqual(4);
    expect(res.body.customers.some((c) => c.customerID === 'CUS-001')).toBe(true);
  });

  it('PATCH /api/customers/:id updates customer and linked display names', async () => {
    const patch = await agent.patch('/api/customers/CUS-001').send({
      name: 'Alhaji Musa Updated',
      phoneNumber: '+234 803 000 0000',
      email: 'updated@example.com',
      addressShipping: 'New address',
      addressBilling: 'New billing',
      status: 'Active',
      tier: 'VIP',
      paymentTerms: 'Net 14',
    });
    expect(patch.status).toBe(200);
    expect(patch.body.ok).toBe(true);

    const res = await agent.get('/api/customers/CUS-001');
    expect(res.body.customer.name).toBe('Alhaji Musa Updated');
    expect(res.body.customer.tier).toBe('VIP');
  });

  it('PATCH /api/customers/:id persists CRM profiling fields', async () => {
    const patch = await agent.patch('/api/customers/CUS-001').send({
      companyName: 'Test Co Ltd',
      leadSource: 'Walk-in',
      preferredContact: 'WhatsApp',
      followUpISO: '2026-04-10',
      crmTags: ['VIP', 'Kano'],
      crmProfileNotes: 'Key account.',
    });
    expect(patch.status).toBe(200);
    const res = await agent.get('/api/customers/CUS-001');
    expect(res.body.customer.companyName).toBe('Test Co Ltd');
    expect(res.body.customer.crmTags).toEqual(['VIP', 'Kano']);
    expect(res.body.customer.followUpISO).toBe('2026-04-10');
    expect(res.body.customer.crmProfileNotes).toContain('Key account');
  });

  it('GET/POST /api/customers/:id/interactions records CRM timeline', async () => {
    const list = await agent.get('/api/customers/CUS-001/interactions');
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.interactions)).toBe(true);
    const post = await agent.post('/api/customers/CUS-001/interactions').send({
      kind: 'note',
      title: 'Test',
      detail: 'Logged interaction',
    });
    expect(post.status).toBe(201);
    const again = await agent.get('/api/customers/CUS-001/interactions');
    expect(again.body.interactions.some((i) => i.detail === 'Logged interaction')).toBe(true);
  });

  it('DELETE /api/customers/:id returns blockers when customer has dependents', async () => {
    const res = await agent.delete('/api/customers/CUS-001');
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(Array.isArray(res.body.blockers)).toBe(true);
    expect(res.body.blockers.length).toBeGreaterThan(0);
    expect(res.body.error).toMatch(/dependent records/i);
  });

  it('DELETE /api/customers/:id removes customer with no dependents', async () => {
    const created = await agent.post('/api/customers').send({
      customerID: 'CUS-DELETE-EMPTY',
      name: 'Ephemeral Delete Test',
    });
    expect(created.status).toBe(201);
    const del = await agent.delete('/api/customers/CUS-DELETE-EMPTY');
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);
    const get = await agent.get('/api/customers/CUS-DELETE-EMPTY');
    expect(get.status).toBe(404);
  });

  it('DELETE /api/customers/:id is forbidden for sales officer (sales manager only)', async () => {
    const staff = request.agent(app);
    await loginAs(staff, 'sales.staff', 'Sales@123');
    const created = await staff.post('/api/customers').send({
      customerID: 'CUS-STAFF-NODEL',
      name: 'Staff Cannot Delete',
    });
    expect(created.status).toBe(201);
    const del = await staff.delete('/api/customers/CUS-STAFF-NODEL');
    expect(del.status).toBe(403);
    expect(del.body.code).toBe('FORBIDDEN');
  });

  it('POST /api/customers rejects duplicate phone in branch (normalized)', async () => {
    const res = await agent.post('/api/customers').send({
      customerID: 'CUS-DUP-PHONE',
      name: 'Dup Phone Test',
      phoneNumber: '08035550142',
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DUPLICATE_CUSTOMER_REGISTRATION');
    expect(res.body.conflictField).toBe('phone');
    expect(res.body.existingCustomerId).toBe('CUS-001');
  });

  it('POST /api/customers rejects duplicate email in branch', async () => {
    const res = await agent.post('/api/customers').send({
      customerID: 'CUS-DUP-EMAIL',
      name: 'Dup Email Test',
      phoneNumber: '+234 999 000 7700',
      email: 'Musa.roofing@example.com',
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DUPLICATE_CUSTOMER_REGISTRATION');
    expect(res.body.conflictField).toBe('email');
  });

  it('PATCH /api/customers/:id rejects phone already used by another customer', async () => {
    const patch = await agent.patch('/api/customers/CUS-002').send({
      phoneNumber: '+234 803 555 0142',
    });
    expect(patch.status).toBe(409);
    expect(patch.body.code).toBe('DUPLICATE_CUSTOMER_REGISTRATION');
    expect(patch.body.conflictField).toBe('phone');
  });

  it('PATCH /api/bank-reconciliation/:lineId updates match status', async () => {
    const boot = await agent.get('/api/bootstrap');
    const line = boot.body.bankReconciliation.find((l) => l.id === 'BR-003');
    expect(line?.status).toBe('Review');
    const patch = await agent.patch('/api/bank-reconciliation/BR-003').send({
      status: 'Matched',
      systemMatch: 'RC-2026-014',
      // Statement line (312_500) differs from receipt (400_000); book settled amount to receipt to avoid variance workflow in this test.
      settledAmountNgn: 400_000,
    });
    expect(patch.status).toBe(200);
    const after = await agent.get('/api/bootstrap');
    const row = after.body.bankReconciliation.find((l) => l.id === 'BR-003');
    expect(row.status).toBe('Matched');
    expect(row.systemMatch).toBe('RC-2026-014');
  });

  it('PATCH /api/bank-reconciliation/:lineId rejects Matched when RC- id is not a receipt', async () => {
    const bad = await agent.patch('/api/bank-reconciliation/BR-003').send({
      status: 'Matched',
      systemMatch: 'RC-NOT-A-REAL-RECEIPT-ID',
    });
    expect(bad.status).toBe(400);
    expect(bad.body.ok).toBe(false);
  });

  it('PATCH /api/bank-reconciliation/:lineId resolves receipt when system match uses unicode dash', async () => {
    const created = await agent.post('/api/bank-reconciliation').send({
      bankDateISO: '2026-04-01',
      description: 'Unicode dash match test',
      amountNgn: 400_000,
    });
    expect(created.status).toBe(201);
    const lineId = created.body.id;
    const patch = await agent.patch(`/api/bank-reconciliation/${lineId}`).send({
      status: 'Matched',
      systemMatch: 'RC\u20132026-014',
      settledAmountNgn: 400_000,
    });
    expect(patch.status).toBe(200);
    expect(patch.body.ok).toBe(true);
    expect(patch.body.status).toBe('Matched');
  });

  it('POST /api/bank-reconciliation creates a statement line in Review', async () => {
    const created = await agent.post('/api/bank-reconciliation').send({
      bankDateISO: '2026-04-01',
      description: 'API test bank line',
      amountNgn: -5000,
    });
    expect(created.status).toBe(201);
    expect(created.body.ok).toBe(true);
    expect(created.body.id).toMatch(/^BKR-/);
    const boot = await agent.get('/api/bootstrap');
    const row = boot.body.bankReconciliation.find((l) => l.id === created.body.id);
    expect(row?.description).toBe('API test bank line');
    expect(row?.amountNgn).toBe(-5000);
    expect(row?.status).toBe('Review');
  });

  it('GET /api/bank-reconciliation lists lines for finance roles', async () => {
    const res = await agent.get('/api/bank-reconciliation');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.lines)).toBe(true);
  });

  it('POST /api/bank-reconciliation/import creates multiple review lines', async () => {
    const res = await agent.post('/api/bank-reconciliation/import').send({
      lines: [
        { bankDateISO: '2026-04-01', description: 'Bulk A', amountNgn: 1000 },
        { bankDateISO: '2026-04-02', description: 'Bulk B', amountNgn: -2000 },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.createdCount).toBe(2);
    expect(res.body.errorCount).toBe(0);
  });

  it('POST /api/bank-reconciliation/import-csv creates lines from text', async () => {
    const csv = `bankDateISO,description,amountNgn
2026-04-10,"Bank fee April",-1500
2026-04-11,Inflow customer A,250000`;
    const res = await agent.post('/api/bank-reconciliation/import-csv').send({ csvText: csv });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.createdCount).toBe(2);
    expect(res.body.skippedDuplicateCount ?? 0).toBe(0);
  });

  it('POST /api/bank-reconciliation/import-csv skips duplicate fingerprints on repeat', async () => {
    const csv = `bankDateISO,description,amountNgn
2026-04-20,"Dup fingerprint row",-8888`;
    const r1 = await agent.post('/api/bank-reconciliation/import-csv').send({ csvText: csv });
    expect(r1.status).toBe(200);
    expect(r1.body.createdCount).toBe(1);
    const r2 = await agent.post('/api/bank-reconciliation/import-csv').send({ csvText: csv });
    expect(r2.status).toBe(200);
    expect(r2.body.createdCount).toBe(0);
    expect(r2.body.skippedDuplicateCount).toBe(1);
  });

  it('POST /api/bank-reconciliation/import skips duplicate fingerprints like CSV', async () => {
    const lines = [{ bankDateISO: '2026-04-21', description: 'JSON dup test', amountNgn: 7777 }];
    const a = await agent.post('/api/bank-reconciliation/import').send({ lines });
    expect(a.status).toBe(200);
    expect(a.body.createdCount).toBe(1);
    const b = await agent.post('/api/bank-reconciliation/import').send({ lines });
    expect(b.status).toBe(200);
    expect(b.body.createdCount).toBe(0);
    expect(b.body.skippedDuplicateCount).toBe(1);
  });

  it('bank CSV import creates finance bank_recon_exceptions work item when lines in Review', async () => {
    const fin = request.agent(app);
    await loginAs(fin, 'finance.manager', 'Finance@123');
    const csv = `bankDateISO,description,amountNgn
2026-04-22,"Work item recon test",-44444`;
    const imp = await fin.post('/api/bank-reconciliation/import-csv').send({ csvText: csv });
    expect(imp.status).toBe(200);
    const boot = await fin.get('/api/bootstrap');
    expect(boot.status).toBe(200);
    const items = boot.body.unifiedWorkItems || [];
    const hit = items.find((i) => i.documentType === 'bank_recon_exceptions');
    expect(hit).toBeTruthy();
    expect(String(hit.title || '')).toMatch(/Bank reconciliation/i);
  });

  it('GET /api/exec/summary returns queue KPIs for managing director', async () => {
    const mdAgent = request.agent(app);
    await loginAs(mdAgent, 'md', 'Md@1234567890!');
    const res = await mdAgent.get('/api/exec/summary');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.payrollDraftsAwaitingMd).toBe('number');
    expect(typeof res.body.bankReconciliationLinesInReview).toBe('number');
    expect(typeof res.body.materialIncidentsPendingApproval).toBe('number');
  });

  it('GET /api/exec/dashboard composes executive command centre for MD and CEO', async () => {
    const mdAgent = request.agent(app);
    await loginAs(mdAgent, 'md', 'Md@1234567890!');
    const mdRes = await mdAgent.get('/api/exec/dashboard?periodKey=month&branchId=ALL');
    expect(mdRes.status).toBe(200);
    expect(mdRes.body.ok).toBe(true);
    expect(mdRes.body.actor.role).toBe('md');
    expect(mdRes.body.kpis).toBeTruthy();
    expect(Array.isArray(mdRes.body.decisionAlerts)).toBe(true);
    expect(mdRes.body.workTray).toBeTruthy();
    expect(Array.isArray(mdRes.body.sales.topCustomersByDebt)).toBe(true);

    const ceoAgent = request.agent(app);
    await loginAs(ceoAgent, 'ceo', 'Ceo@1234567890!');
    const ceoRes = await ceoAgent.get('/api/exec/dashboard?periodKey=today');
    expect(ceoRes.status).toBe(200);
    expect(ceoRes.body.ok).toBe(true);
    expect(ceoRes.body.actor.role).toBe('ceo');
    expect(ceoRes.body.actor.readOnlyExecutiveView).toBe(true);
    expect(ceoRes.body.workTray.readOnlyForActor).toBe(true);
    const anyCanAct = (ceoRes.body.workTray.items || []).some((i) => i.canAct === true);
    expect(anyCanAct).toBe(false);
    expect(Array.isArray(ceoRes.body.dataScopeNotes)).toBe(true);
    expect(ceoRes.body.dataScopeNotes.length).toBeGreaterThan(0);
    expect(ceoRes.body.period.biPeriodKey).toBe('custom');
    expect(ceoRes.body.period.kpiPeriodAware).toBe(true);
    const stubIds = (ceoRes.body.workTray.items || []).filter((i) =>
      /:queue:\d+$/.test(String(i.id || ''))
    );
    expect(stubIds).toHaveLength(0);
    const summaryRows = (ceoRes.body.workTray.items || []).filter((i) => i.summaryOnly);
    if (summaryRows.length) {
      expect(summaryRows.every((i) => i.canAct === false)).toBe(true);
    }
    expect(ceoRes.body.cash.pendingRefundsIsCount).toBe(true);
    expect(ceoRes.body.kpis.collectionRateLabel).toBeTruthy();
    expect(ceoRes.body.workingCapital?.notWithdrawableCash).toBe(true);
    expect(ceoRes.body.materialCosting?.excludes).toEqual(
      expect.arrayContaining(['labour', 'diesel'])
    );
    expect(ceoRes.body.staffActivity?.notPerformanceRanking).toBe(true);
    expect(ceoRes.body.reservePolicy?.headroomHidden).toBe(true);
    expect(ceoRes.body.targets?.basis).toBe('company');
    expect(ceoRes.body.actor.canManageReservePolicy).toBe(false);
    expect(mdRes.body.actor.canManageReservePolicy).toBe(true);
    expect(typeof mdRes.body.reservePolicy?.completionPct).toBe('number');
  });

  it('GET/PUT /api/exec/reserve-policy enforces RBAC and validation', async () => {
    const mdAgent = request.agent(app);
    await loginAs(mdAgent, 'md', 'Md@1234567890!');
    const get0 = await mdAgent.get('/api/exec/reserve-policy');
    expect(get0.status).toBe(200);
    expect(get0.body.ok).toBe(true);
    expect(get0.body.headroomHidden).toBe(true);

    const badPut = await mdAgent.put('/api/exec/reserve-policy').send({
      operatingReserveNgn: 'lots',
      emergencyReserveNgn: 0,
      payrollReserveNgn: 0,
      supplierPaymentReserveNgn: 0,
      stockPurchaseReserveNgn: 0,
      taxStatutoryReserveNgn: 0,
      includeReceivables: false,
      includeInventory: false,
      includePoCommitments: true,
    });
    expect(badPut.status).toBe(400);

    const goodPut = await mdAgent.put('/api/exec/reserve-policy').send({
      operatingReserveNgn: 2_000_000,
      emergencyReserveNgn: 1_000_000,
      payrollReserveNgn: 500_000,
      supplierPaymentReserveNgn: 400_000,
      stockPurchaseReserveNgn: 300_000,
      taxStatutoryReserveNgn: 200_000,
      includeReceivables: false,
      includeInventory: false,
      includePoCommitments: true,
      policyNotes: 'Test reserve policy',
    });
    expect(goodPut.status).toBe(200);
    expect(goodPut.body.configured).toBe(true);
    expect(goodPut.body.completionPct).toBe(100);

    const auditRow = db
      .prepare(
        `SELECT COUNT(*) AS c FROM org_policy_audit WHERE policy_key = 'treasury.reserves.operating_ngn'`
      )
      .get();
    expect(Number(auditRow?.c)).toBeGreaterThan(0);

    const ceoAgent = request.agent(app);
    await loginAs(ceoAgent, 'ceo', 'Ceo@1234567890!');
    const ceoPut = await ceoAgent.put('/api/exec/reserve-policy').send({
      operatingReserveNgn: 1,
      emergencyReserveNgn: 1,
      payrollReserveNgn: 1,
      supplierPaymentReserveNgn: 1,
      stockPurchaseReserveNgn: 1,
      taxStatutoryReserveNgn: 1,
      includeReceivables: false,
      includeInventory: false,
      includePoCommitments: true,
    });
    expect(ceoPut.status).toBe(403);

    const dash = await mdAgent.get('/api/exec/dashboard?periodKey=month');
    expect(dash.body.reservePolicy?.configured).toBe(true);
    expect(dash.body.reservePolicy?.headroomHidden).toBe(true);
  });

  it('GET /api/advance-deposits requires sign-in and ledger-related permission', async () => {
    const anon = await request(app).get('/api/advance-deposits');
    expect(anon.status).toBe(401);
    const staffAgent = request.agent(app);
    await loginAs(staffAgent, 'sales.staff', 'Sales@123');
    const v = await staffAgent.get('/api/advance-deposits');
    expect(v.status).toBe(403);
  });

  it('POST /api/ledger/advance returns same entry when Idempotency-Key repeats', async () => {
    const idemKey = `idem-adv-${Date.now()}`;
    const body = {
      customerID: 'CUS-001',
      amountNgn: 3_000,
      paymentMethod: 'Cash',
      dateISO: '2026-03-28',
    };
    const r1 = await agent.post('/api/ledger/advance').set('Idempotency-Key', idemKey).send(body);
    expect(r1.status).toBe(201);
    expect(r1.body.entry?.id).toBeTruthy();
    const r2 = await agent.post('/api/ledger/advance').set('Idempotency-Key', idemKey).send(body);
    expect(r2.status).toBe(201);
    expect(r2.body.entry.id).toBe(r1.body.entry.id);
    const row = db.prepare(`SELECT COUNT(*) AS c FROM ledger_entries WHERE id = ?`).get(r1.body.entry.id);
    expect(row.c).toBe(1);
  });

  it('POST /api/ledger/advance then summary shows advance', async () => {
    const before = await agent.get('/api/bootstrap');
    const treasuryAccountId = before.body.treasuryAccounts[0].id;
    const balanceBefore = before.body.treasuryAccounts[0].balance;
    const adv = await agent.post('/api/ledger/advance').send({
      customerID: 'CUS-001',
      amountNgn: 100_000,
      paymentMethod: 'Transfer',
      bankReference: 'REF-1',
      purpose: 'Deposit',
      dateISO: '2026-03-28',
      treasuryAccountId,
      paymentLines: [{ treasuryAccountId, amountNgn: 100_000, reference: 'REF-1' }],
    });
    expect(adv.status).toBe(201);
    expect(adv.body.entry.type).toBe('ADVANCE_IN');

    const sum = await agent.get('/api/customers/CUS-001/summary');
    expect(sum.status).toBe(200);
    expect(sum.body.advanceNgn).toBe(100_000);

    const dep = await agent.get('/api/advance-deposits');
    expect(dep.status).toBe(200);
    expect(dep.body.advances.some((a) => a.ledgerEntryId === adv.body.entry.id)).toBe(true);

    const after = await agent.get('/api/bootstrap');
    const acc = after.body.treasuryAccounts.find((a) => a.id === treasuryAccountId);
    expect(acc.balance).toBe(balanceBefore + 100_000);
    expect(
      after.body.treasuryMovements.some(
        (m) => m.sourceKind === 'LEDGER_ADVANCE' && m.sourceId === adv.body.entry.id
      )
    ).toBe(true);
  });

  it('POST /api/ledger/apply-advance applies deposit to quotation', async () => {
    const before = await agent.get('/api/bootstrap');
    const treasuryAccountId = before.body.treasuryAccounts[0].id;
    const q = await agent.post('/api/quotations').send({
      customerID: 'CUS-001',
      projectName: `Advance apply ${Date.now()}`,
      dateISO: '2026-03-29',
      lines: {
        products: [{ name: 'Test item', qty: '1', unitPrice: '100000' }],
        accessories: [],
        services: [],
      },
    });
    expect(q.status).toBe(201);
    const quotationRef = q.body.quotation?.quotationID || q.body.quotation?.id || q.body.quotationID || q.body.id;
    expect(String(quotationRef || '')).toBeTruthy();
    await agent.post('/api/ledger/advance').send({
      customerID: 'CUS-001',
      amountNgn: 50_000,
      paymentMethod: 'Transfer',
      dateISO: '2026-03-28',
      treasuryAccountId,
      paymentLines: [{ treasuryAccountId, amountNgn: 50_000, reference: 'DEP-APPLY' }],
    });

    const apply = await agent.post('/api/ledger/apply-advance').send({
      customerID: 'CUS-001',
      quotationRef,
      amountNgn: 50_000,
    });
    expect(apply.status).toBe(201);
    expect(apply.body.entry.type).toBe('ADVANCE_APPLIED');
  });

  it('POST /api/ledger/receipt records full amount on quotation (no split at post)', async () => {
    const before = await agent.get('/api/bootstrap');
    const treasuryAccountId = before.body.treasuryAccounts[0].id;
    const res = await agent.post('/api/ledger/receipt').send({
      customerID: 'CUS-003',
      quotationId: 'QT-2026-004',
      amountNgn: 650_000,
      paymentMethod: 'Cash',
      bankReference: 'RCP-1 — cash receipt',
      dateISO: '2026-03-28',
      treasuryAccountId,
      paymentLines: [{ treasuryAccountId, amountNgn: 650_000, reference: 'RCP-1' }],
    });
    expect(res.status).toBe(201);
    expect(res.body.receipt.amountNgn).toBe(650_000);
    expect(res.body.overpay).toBeNull();

    const sum = await agent.get('/api/customers/CUS-003/summary');
    expect(sum.body.advanceNgn).toBe(0);

    const boot = await agent.get('/api/bootstrap');
    const sr = boot.body.receipts.find((r) => r.id === res.body.receipt.id);
    expect(sr).toBeDefined();
    expect(sr.amountNgn).toBe(650_000);
    expect(sr.ledgerEntryId).toBe(res.body.receipt.id);
  });

  it.skipIf(!mysqlOk)('POST /api/ledger/receipt rejects amendSalesReceiptId re-post', async () => {
    const q = await agent.post('/api/quotations').send({
      customerID: 'CUS-002',
      projectName: `Amend block ${Date.now()}`,
      dateISO: '2026-03-29',
      lines: {
        products: [{ name: 'Test item', qty: '1', unitPrice: '100000' }],
        accessories: [],
        services: [],
      },
    });
    expect(q.status).toBe(201);
    const quotationId = q.body.quotation?.id || q.body.quotationID || q.body.id;
    const receipt = await agent.post('/api/ledger/receipt').send({
      customerID: 'CUS-002',
      quotationId,
      amountNgn: 50_000,
      paymentMethod: 'Transfer',
      bankReference: 'TRF-AMEND-BLOCK',
      dateISO: '2026-03-29',
    });
    expect(receipt.status).toBe(201);
    const amend = await agent.post('/api/ledger/receipt').send({
      customerID: 'CUS-002',
      quotationId,
      amountNgn: 50_000,
      paymentMethod: 'Transfer',
      bankReference: 'TRF-AMEND-BLOCK-2',
      dateISO: '2026-03-29',
      amendSalesReceiptId: receipt.body.receipt.id,
    });
    expect(amend.status).toBe(400);
    expect(amend.body.code).toBe('RECEIPT_AMEND_NOT_ALLOWED');
  });

  it.skipIf(!mysqlOk)('POST /api/ledger/receipt requires confirm amount for large posts', async () => {
    const q = await agent.post('/api/quotations').send({
      customerID: 'CUS-002',
      projectName: `Confirm amt ${Date.now()}`,
      dateISO: '2026-03-29',
      lines: {
        products: [{ name: 'Test item', qty: '1', unitPrice: '500000' }],
        accessories: [],
        services: [],
      },
    });
    expect(q.status).toBe(201);
    const quotationId = q.body.quotation?.id || q.body.quotationID || q.body.id;
    const bad = await agent.post('/api/ledger/receipt').send({
      customerID: 'CUS-002',
      quotationId,
      amountNgn: 148_000,
      paymentMethod: 'Transfer',
      bankReference: 'TRF-NO-CONFIRM',
      dateISO: '2026-03-29',
    });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('RECEIPT_AMOUNT_CONFIRM_REQUIRED');
    const ok = await agent.post('/api/ledger/receipt').send({
      customerID: 'CUS-002',
      quotationId,
      amountNgn: 148_000,
      confirmAmountNgn: 148_000,
      paymentMethod: 'Transfer',
      bankReference: 'TRF-WITH-CONFIRM',
      dateISO: '2026-03-29',
    });
    expect(ok.status).toBe(201);
  });

  it.skipIf(!mysqlOk)('POST /api/ledger/reverse-receipt reverses a posted receipt', async () => {
    const q = await agent.post('/api/quotations').send({
      customerID: 'CUS-002',
      projectName: `Reverse receipt ${Date.now()}`,
      dateISO: '2026-03-29',
      lines: {
        products: [{ name: 'Test item', qty: '1', unitPrice: '200000' }],
        accessories: [],
        services: [],
      },
    });
    expect(q.status).toBe(201);
    const quotationId = q.body.quotation?.id || q.body.quotation?.quotationID || q.body.quotationID || q.body.id;
    expect(String(quotationId || '')).toBeTruthy();
    const receipt = await agent.post('/api/ledger/receipt').send({
      customerID: 'CUS-002',
      quotationId,
      amountNgn: 100_000,
      paymentMethod: 'Transfer',
      bankReference: 'TRF-REVERSAL-TEST-001',
      dateISO: '2026-03-29',
    });
    expect(receipt.status).toBe(201);

    const rev = await agent.post('/api/ledger/reverse-receipt').send({
      entryId: receipt.body.receipt.id,
      note: 'Wrong posting',
    });
    expect(rev.status).toBe(201);
    expect(rev.body.entry.type).toBe('RECEIPT_REVERSAL');

    const sum = await agent.get('/api/customers/CUS-002/summary');
    const row = sum.body.outstandingByQuotation.find((q) => q.quotationId === 'QT-2026-002');
    expect(row.amountDueNgn).toBeGreaterThan(0);
  });

  it('POST /api/ledger/reverse-advance reverses a deposit and removes it from advances list', async () => {
    const adv = await agent.post('/api/ledger/advance').send({
      customerID: 'CUS-004',
      amountNgn: 75_000,
      paymentMethod: 'Transfer',
      dateISO: '2026-03-29',
    });
    expect(adv.status).toBe(201);

    const rev = await agent.post('/api/ledger/reverse-advance').send({
      entryId: adv.body.entry.id,
      note: 'Duplicate deposit',
    });
    expect(rev.status).toBe(201);
    expect(rev.body.entry.type).toBe('ADVANCE_REVERSAL');

    const dep = await agent.get('/api/advance-deposits');
    expect(dep.body.advances.some((a) => a.ledgerEntryId === adv.body.entry.id)).toBe(false);
  });

  it('POST /api/ledger/reverse-advance posts reversing GL when advance had treasury', async () => {
    const before = await agent.get('/api/bootstrap');
    const treasuryAccountId = before.body.treasuryAccounts[0].id;
    const adv = await agent.post('/api/ledger/advance').send({
      customerID: 'CUS-004',
      amountNgn: 50_000,
      paymentMethod: 'Transfer',
      dateISO: '2026-03-30',
      treasuryAccountId,
      paymentLines: [{ treasuryAccountId, amountNgn: 50_000, reference: 'ADV-GL-TST' }],
    });
    expect(adv.status).toBe(201);
    const advGl = db
      .prepare(`SELECT id FROM gl_journal_entries WHERE source_kind = 'CUSTOMER_ADVANCE_GL' AND source_id = ?`)
      .get(adv.body.entry.id);
    expect(advGl).toBeTruthy();

    const rev = await agent.post('/api/ledger/reverse-advance').send({
      entryId: adv.body.entry.id,
      note: 'Test advance GL reversal',
    });
    expect(rev.status).toBe(201);
    const revGl = db
      .prepare(`SELECT id FROM gl_journal_entries WHERE source_kind = 'CUSTOMER_ADVANCE_REV_GL' AND source_id = ?`)
      .get(rev.body.entry.id);
    expect(revGl).toBeTruthy();
  });

  it('POST /api/quotations persists lines and totals', async () => {
    const res = await agent.post('/api/quotations').send({
      customerID: 'CUS-001',
      projectName: 'North shed',
      dateISO: '2026-03-29',
      lines: {
        products: [{ name: 'Roofing Sheet', qty: '10', unitPrice: '5000' }],
        accessories: [],
        services: [],
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.quotationId).toMatch(/^QT-/);
    expect(res.body.quotation.totalNgn).toBe(50_000);
    expect(res.body.quotation.projectName).toBe('North shed');
  });

  it('PATCH /api/quotations updates persisted quotation', async () => {
    const created = await agent.post('/api/quotations').send({
      customerID: 'CUS-001',
      projectName: 'North shed',
      dateISO: '2026-03-29',
      lines: {
        products: [{ name: 'Roofing Sheet', qty: '10', unitPrice: '5000' }],
        accessories: [],
        services: [],
      },
    });
    const patch = await agent.patch(`/api/quotations/${encodeURIComponent(created.body.quotationId)}`).send({
      customerFeedback: 'Approved on site',
      status: 'Approved',
    });
    expect(patch.status).toBe(200);
    expect(patch.body.quotation.customerFeedback).toBe('Approved on site');
    expect(patch.body.quotation.status).toBe('Approved');
  });

  it('POST /api/quotations returns 422 when stone-coated quote has Coil without Flat sheet', async () => {
    const g = db.prepare(`SELECT label FROM setup_gauges WHERE active = 1 LIMIT 1`).get();
    const gaugeLabel = g?.label || '0.45mm';
    const res = await agent.post('/api/quotations').send({
      customerID: 'CUS-001',
      projectName: 'Stone coil rule',
      dateISO: '2026-03-29',
      materialTypeId: 'MAT-005',
      materialGauge: gaugeLabel,
      materialColor: 'HM Blue',
      materialDesign: 'Milano',
      lines: {
        products: [{ name: 'Coil', qty: '1', unitPrice: '1000' }],
        accessories: [],
        services: [],
      },
    });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('QUOTATION_MATERIAL_RULES');
    expect(res.body.details?.invalidProductNames).toContain('Coil');
  });

  it('POST /api/quotations allows stone-coated Coil when Flat sheet present', async () => {
    const g = db.prepare(`SELECT label FROM setup_gauges WHERE active = 1 LIMIT 1`).get();
    const gaugeLabel = g?.label || '0.45mm';
    const res = await agent.post('/api/quotations').send({
      customerID: 'CUS-001',
      projectName: 'Stone hybrid',
      dateISO: '2026-03-29',
      materialTypeId: 'MAT-005',
      materialGauge: gaugeLabel,
      materialColor: 'HM Blue',
      materialDesign: 'Milano',
      lines: {
        products: [
          { name: 'Flat sheet', qty: '2', unitPrice: '1000' },
          { name: 'Coil', qty: '1', unitPrice: '500' },
        ],
        accessories: [{ name: 'Stone nail', qty: '1', unitPrice: '100' }],
        services: [],
      },
    });
    expect(res.status).toBe(201);
    expect(res.body.quotationId).toMatch(/^QT-/);
  });

  it('POST /api/suppliers then bootstrap lists it', async () => {
    const create = await agent.post('/api/suppliers').send({
      name: 'API Test Supplier',
      city: 'Kano',
      paymentTerms: 'Credit',
      qualityScore: 77,
      notes: 'from test',
      supplierProfile: {
        companyEmail: 'vendor-api-test@zarewa.test',
        phoneMain: '+2348000000001',
        bankAccounts: [{ bankName: 'Test Bank', accountName: 'API Supplier', accountNumber: '0011223344', sortCode: '' }],
        contacts: [{ name: 'Contact A', role: 'Accounts', email: 'acct@zarewa.test', phone: '' }],
        agreements: [],
      },
    });
    expect(create.status).toBe(201);
    expect(create.body.ok).toBe(true);
    expect(create.body.supplierID).toMatch(/^SUP-/);

    const boot = await agent.get('/api/bootstrap');
    expect(boot.body.suppliers.some((s) => s.supplierID === create.body.supplierID)).toBe(true);
    const row = boot.body.suppliers.find((s) => s.supplierID === create.body.supplierID);
    expect(row.name).toBe('API Test Supplier');
    expect(row.qualityScore).toBe(77);
    expect(row.supplierProfile?.companyEmail).toBe('vendor-api-test@zarewa.test');
    expect(row.supplierProfile?.bankAccounts?.[0]?.accountNumber).toBe('0011223344');
  });

  it('POST /api/suppliers rejects duplicate name company-wide (normalized)', async () => {
    const first = await agent.post('/api/suppliers').send({
      name: 'Dup Test Metals Ltd',
      city: 'Kano',
    });
    expect(first.status).toBe(201);
    const res = await agent.post('/api/suppliers').send({
      name: 'Dup Test Metals Limited',
      city: 'Abuja',
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DUPLICATE_SUPPLIER_REGISTRATION');
    expect(res.body.existingSupplierId).toBe(first.body.supplierID);
  });

  it('POST /api/suppliers rejects duplicate phone in profile', async () => {
    const first = await agent.post('/api/suppliers').send({
      name: 'Phone Dup Alpha',
      supplierProfile: { phoneMain: '08039998877' },
    });
    expect(first.status).toBe(201);
    const res = await agent.post('/api/suppliers').send({
      name: 'Phone Dup Beta',
      supplierProfile: { phoneMain: '+2348039998877' },
    });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('DUPLICATE_SUPPLIER_REGISTRATION');
    expect(res.body.conflictField).toBe('phone');
  });

  it('PATCH /api/suppliers/:id updates name and PO supplier_name', async () => {
    const create = await agent.post('/api/suppliers').send({ name: 'Temp Co', city: 'Lagos' });
    const sid = create.body.supplierID;
    const po = await agent.post('/api/purchase-orders').send({
      supplierID: sid,
      supplierName: 'Temp Co',
      orderDateISO: '2026-03-28',
      expectedDeliveryISO: '',
      status: 'Pending',
      lines: [
        {
          lineKey: 'L1',
          productID: 'COIL-ALU',
          productName: 'Test coil',
          qtyOrdered: 10,
          unitPricePerKgNgn: 100,
          unitPriceNgn: 100,
          qtyReceived: 0,
        },
      ],
    });
    expect(po.status).toBe(201);

    const patch = await agent.patch(`/api/suppliers/${encodeURIComponent(sid)}`).send({
      name: 'Temp Co Renamed',
      city: 'Abuja',
      paymentTerms: 'Advance',
    });
    expect(patch.status).toBe(200);
    expect(patch.body.ok).toBe(true);

    const boot = await agent.get('/api/bootstrap');
    const s = boot.body.suppliers.find((x) => x.supplierID === sid);
    expect(s.name).toBe('Temp Co Renamed');
    const p = boot.body.purchaseOrders.find((x) => x.poID === po.body.poID);
    expect(p.supplierName).toBe('Temp Co Renamed');
  });

  it('PATCH /api/purchase-orders/:poId revises draft coil PO header and lines', async () => {
    const create = await agent.post('/api/suppliers').send({ name: 'PO Patch Supplier', city: 'Lagos' });
    const sid = create.body.supplierID;
    const po = await agent.post('/api/purchase-orders').send({
      supplierID: sid,
      supplierName: 'PO Patch Supplier',
      orderDateISO: '2026-04-01',
      expectedDeliveryISO: '',
      status: 'Pending',
      lines: [
        {
          lineKey: 'L1',
          productID: 'COIL-ALU',
          productName: 'Aluminium coil',
          color: 'HM Blue',
          gauge: '0.40mm',
          qtyOrdered: 5,
          unitPricePerKgNgn: 200,
          unitPriceNgn: 200,
          qtyReceived: 0,
        },
      ],
    });
    expect(po.status).toBe(201);
    const poId = po.body.poID;
    const patch = await agent.patch(`/api/purchase-orders/${encodeURIComponent(poId)}`).send({
      supplierID: sid,
      supplierName: 'PO Patch Supplier',
      orderDateISO: '2026-04-02',
      expectedDeliveryISO: '2026-04-15',
      lines: [
        {
          lineKey: 'L1',
          productID: 'COIL-ALU',
          productName: 'Aluminium coil',
          color: 'Traffic Black',
          gauge: '0.55mm',
          qtyOrdered: 8,
          unitPricePerKgNgn: 210,
          unitPriceNgn: 210,
        },
      ],
    });
    expect(patch.status).toBe(200);
    expect(patch.body.ok).toBe(true);
    const boot = await agent.get('/api/bootstrap');
    const row = boot.body.purchaseOrders.find((x) => x.poID === poId);
    expect(row.orderDateISO).toBe('2026-04-02');
    expect(row.expectedDeliveryISO).toBe('2026-04-15');
    expect(row.lines.length).toBe(1);
    expect(row.lines[0].color).toBe('Traffic Black');
    expect(row.lines[0].qtyOrdered).toBe(8);
  });

  it('DELETE /api/suppliers/:id fails when POs exist', async () => {
    const boot = await agent.get('/api/bootstrap');
    const sid = boot.body.purchaseOrders[0]?.supplierID;
    expect(sid).toBeTruthy();
    const del = await agent.delete(`/api/suppliers/${encodeURIComponent(sid)}`);
    expect(del.status).toBe(400);
    expect(del.body.ok).toBe(false);
  });

  it('DELETE /api/suppliers/:id succeeds when no POs', async () => {
    const create = await agent.post('/api/suppliers').send({ name: 'Orphan Supplier' });
    const sid = create.body.supplierID;
    const del = await agent.delete(`/api/suppliers/${encodeURIComponent(sid)}`);
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);
  });

  it('POST /api/transport-agents CRUD', async () => {
    const c = await agent.post('/api/transport-agents').send({
      name: 'Test Haulage',
      region: 'North',
      phone: '0800',
    });
    expect(c.status).toBe(201);
    const aid = c.body.id;
    expect(aid).toMatch(/^AG-/);

    const p = await agent
      .patch(`/api/transport-agents/${encodeURIComponent(aid)}`)
      .send({ name: 'Test Haulage Ltd', region: 'North', phone: '0801' });
    expect(p.status).toBe(200);

    const del = await agent.delete(`/api/transport-agents/${encodeURIComponent(aid)}`);
    expect(del.status).toBe(200);
  });

  it('PO transport: link → Finance queue; treasury payments drive in transit and settlement', async () => {
    const sup = await agent.post('/api/suppliers').send({ name: 'Haul Test Sup', city: 'Kano' });
    expect(sup.status).toBe(201);
    const tid = (
      await agent.post('/api/transport-agents').send({ name: 'Haul Co', region: 'North', phone: '080' })
    ).body.id;
    const po = await agent.post('/api/purchase-orders').send({
      supplierID: sup.body.supplierID,
      supplierName: 'Haul Test Sup',
      orderDateISO: '2026-03-29',
      expectedDeliveryISO: '',
      status: 'Approved',
      lines: [
        {
          lineKey: 'L1',
          productID: 'COIL-ALU',
          productName: 'Coil',
          qtyOrdered: 100,
          unitPricePerKgNgn: 100,
          unitPriceNgn: 100,
          qtyReceived: 0,
        },
      ],
    });
    expect(po.status).toBe(201);
    const poId = po.body.poID;
    const link = await agent.patch(`/api/purchase-orders/${encodeURIComponent(poId)}/link-transport`).send({
      transportAgentId: tid,
      transportAgentName: 'Haul Co',
      transportReference: 'WB-123',
      transportAmountNgn: 100_000,
    });
    expect(link.status).toBe(200);
    let boot = await agent.get('/api/bootstrap');
    let row = boot.body.purchaseOrders.find((p) => p.poID === poId);
    expect(row.status).toBe('On loading');

    const postFree = await agent.post(`/api/purchase-orders/${encodeURIComponent(poId)}/post-transport`).send({
      reference: 'WB-123',
      dateISO: '2026-03-29',
    });
    expect(postFree.status).toBe(400);
    expect(postFree.body.ok).toBe(false);

    const accounts = boot.body.treasuryAccounts;
    expect(accounts.length).toBeGreaterThan(0);
    const acctId = accounts[0].id;
    const post = await agent.post(`/api/purchase-orders/${encodeURIComponent(poId)}/post-transport`).send({
      treasuryAccountId: acctId,
      amountNgn: 100_000,
      reference: 'WB-123',
      dateISO: '2026-03-29',
    });
    expect(post.status).toBe(200);
    boot = await agent.get('/api/bootstrap');
    row = boot.body.purchaseOrders.find((p) => p.poID === poId);
    expect(row.status).toBe('In Transit');
    expect(row.transportPaid).toBe(true);
    expect(row.transportTreasuryMovementId).toBeTruthy();

    const sup2 = await agent.post('/api/suppliers').send({ name: 'Haul Test Sup 2', city: 'Jos' });
    const po2 = await agent.post('/api/purchase-orders').send({
      supplierID: sup2.body.supplierID,
      supplierName: 'Haul Test Sup 2',
      orderDateISO: '2026-03-29',
      status: 'Approved',
      lines: [
        {
          lineKey: 'L1',
          productID: 'COIL-ALU',
          productName: 'Coil',
          qtyOrdered: 50,
          unitPricePerKgNgn: 100,
          unitPriceNgn: 100,
          qtyReceived: 0,
        },
      ],
    });
    const poId2 = po2.body.poID;
    await agent.patch(`/api/purchase-orders/${encodeURIComponent(poId2)}/link-transport`).send({
      transportAgentId: tid,
      transportAgentName: 'Haul Co',
      transportReference: 'WB-999',
      transportAmountNgn: 100_000,
      transportAdvanceNgn: 40_000,
    });
    boot = await agent.get('/api/bootstrap');
    row = boot.body.purchaseOrders.find((p) => p.poID === poId2);
    expect(row.status).toBe('On loading');
    const postAdv = await agent.post(`/api/purchase-orders/${encodeURIComponent(poId2)}/post-transport`).send({
      treasuryAccountId: acctId,
      amountNgn: 40_000,
      reference: 'WB-999-a',
      dateISO: '2026-03-29',
    });
    expect(postAdv.status).toBe(200);
    boot = await agent.get('/api/bootstrap');
    row = boot.body.purchaseOrders.find((p) => p.poID === poId2);
    expect(row.status).toBe('In Transit');
    expect(row.transportPaid).toBe(false);
    const postBal = await agent.post(`/api/purchase-orders/${encodeURIComponent(poId2)}/post-transport`).send({
      treasuryAccountId: acctId,
      amountNgn: 60_000,
      reference: 'WB-999-b',
      dateISO: '2026-03-29',
    });
    expect(postBal.status).toBe(200);
    boot = await agent.get('/api/bootstrap');
    row = boot.body.purchaseOrders.find((p) => p.poID === poId2);
    expect(row.transportPaid).toBe(true);
    expect(row.transportTreasuryMovementId).toBeTruthy();
    const tm = boot.body.treasuryMovements.find((m) => m.id === row.transportTreasuryMovementId);
    expect(tm?.sourceKind).toBe('PURCHASE_ORDER');
    expect(tm?.sourceId).toBe(poId2);
  });

  it('allows transport link on In Transit PO when supplier paid before haulier was assigned', async () => {
    const sup = await agent.post('/api/suppliers').send({ name: 'Late Haul Sup', city: 'Kano' });
    expect(sup.status).toBe(201);
    const tid = (
      await agent.post('/api/transport-agents').send({ name: 'Late Haul Co', region: 'North', phone: '080' })
    ).body.id;
    const po = await agent.post('/api/purchase-orders').send({
      supplierID: sup.body.supplierID,
      supplierName: 'Late Haul Sup',
      orderDateISO: '2026-03-29',
      status: 'Approved',
      lines: [
        {
          lineKey: 'L1',
          productID: 'COIL-ALU',
          productName: 'Coil',
          qtyOrdered: 100,
          unitPricePerKgNgn: 100,
          unitPriceNgn: 100,
          qtyReceived: 0,
        },
      ],
    });
    expect(po.status).toBe(201);
    const poId = po.body.poID;
    const st = await agent.patch(`/api/purchase-orders/${encodeURIComponent(poId)}/status`).send({
      status: 'In Transit',
    });
    expect(st.status).toBe(200);
    const link = await agent.patch(`/api/purchase-orders/${encodeURIComponent(poId)}/link-transport`).send({
      transportAgentId: tid,
      transportAgentName: 'Late Haul Co',
      transportReference: 'LH-1',
      transportAmountNgn: 75_000,
      transportAdvanceNgn: 75_000,
    });
    expect(link.status).toBe(200);
    expect(link.body.ok).toBe(true);
    const boot = await agent.get('/api/bootstrap');
    const row = boot.body.purchaseOrders.find((p) => p.poID === poId);
    expect(row.transportAgentName).toBe('Late Haul Co');
    expect(row.transportAmountNgn).toBe(75_000);
    expect(row.status).toBe('In Transit');
  });

  it('POST /api/cutting-lists and /api/production-jobs persist linked production flow', async () => {
    const cutting = await agent.post('/api/cutting-lists').send({
      quotationRef: 'QT-2026-005',
      customerID: 'CUS-001',
      productID: 'FG-101',
      productName: 'Longspan thin',
      dateISO: '2026-03-29',
      machineName: 'Machine 01 (Longspan)',
      operatorName: 'Ibrahim',
      lines: [
        { sheets: 4, lengthM: 6 },
        { sheets: 2, lengthM: 4.5 },
      ],
    });
    expect(cutting.status).toBe(201);
    expect(cutting.body.cuttingList.totalMeters).toBe(33);

    const job = await agent.post('/api/production-jobs').send({
      cuttingListId: cutting.body.id,
      productID: 'FG-101',
      productName: 'Longspan thin',
      plannedMeters: 33,
      plannedSheets: 6,
      status: 'Planned',
    });
    expect(job.status).toBe(201);

    const previewWhilePlanned = await agent
      .post(`/api/production-jobs/${encodeURIComponent(job.body.jobID)}/conversion-preview`)
      .send({
        allocations: [{ coilNo: 'X', closingWeightKg: 1, metersProduced: 1 }],
      });
    expect(previewWhilePlanned.status).toBe(400);

    const boot = await agent.get('/api/bootstrap');
    const cl = boot.body.cuttingLists.find((row) => row.id === cutting.body.id);
    expect(cl.productionRegistered).toBe(true);
    expect(cl.productionRegisterRef).toBe(job.body.jobID);
    expect(cl.productionEditLocked).toBe(false);
  });



  it('POST /api/expenses and /api/treasury/transfer post treasury movements', async () => {
    const before = await agent.get('/api/bootstrap');
    const [from, to] = before.body.treasuryAccounts.slice(0, 2);

    const expense = await agent.post('/api/expenses').send({
      expenseType: 'Operational - rent & utilities',
      amountNgn: 20_000,
      date: '2026-03-29',
      category: 'Rent & utilities',
      paymentMethod: 'Cash',
      treasuryAccountId: from.id,
      reference: 'EXP-TEST',
    });
    expect(expense.status).toBe(201);

    const transfer = await agent.post('/api/treasury/transfer').send({
      fromId: from.id,
      toId: to.id,
      amountNgn: 10_000,
      reference: 'Float sweep',
    });
    expect(transfer.status).toBe(201);

    const after = await agent.get('/api/bootstrap');
    expect(after.body.treasuryMovements.some((m) => m.sourceKind === 'EXPENSE')).toBe(true);
    expect(after.body.treasuryMovements.some((m) => m.sourceKind === 'TREASURY_TRANSFER')).toBe(true);
  });

  it('POST /api/payment-requests and /decision review the approval flow', async () => {
    const expense = await agent.post('/api/expenses').send({
      expenseType: 'Generator service',
      amountNgn: 15_000,
      date: '2026-03-29',
      category: 'Maintenance',
      paymentMethod: 'Cash',
      treasuryAccountId: 1,
      reference: 'EXP-REQ',
    });
    expect(expense.status).toBe(201);

    const createReq = await agent.post('/api/payment-requests').send({
      expenseID: expense.body.expenseID,
      amountRequestedNgn: 15_000,
      requestDate: '2026-03-29',
      description: 'Request diesel top-up',
    });
    expect(createReq.status).toBe(201);

    const approve = await agent
      .post(`/api/payment-requests/${encodeURIComponent(createReq.body.requestID)}/decision`)
      .send({ status: 'Approved', note: 'Approved for payment.' });
    expect(approve.status).toBe(200);

    const boot = await agent.get('/api/bootstrap');
    const reqRow = boot.body.paymentRequests.find((r) => r.requestID === createReq.body.requestID);
    expect(reqRow.approvalStatus).toBe('Approved');
    expect(reqRow.approvedBy).toBeTruthy();
  });

  it('sales officer can POST /api/payment-requests with expenses.create (line-item request)', async () => {
    const staffAgent = request.agent(app);
    await loginAs(staffAgent, 'sales.staff', 'Sales@123');
    const createReq = await staffAgent.post('/api/payment-requests').send({
      requestDate: '2026-03-29',
      expenseCategory: 'Stationery',
      description: 'Branch stationery top-up',
      lineItems: [{ description: 'Paper reams', quantity: 2, unitPriceNgn: 5000 }],
    });
    expect(createReq.status).toBe(201);
    expect(createReq.body?.ok).toBe(true);
    expect(String(createReq.body?.requestID || '')).toMatch(/^PREQ-/);
  });

  it('sales officer can PATCH pending payment request with expenses.create', async () => {
    const staffAgent = request.agent(app);
    await loginAs(staffAgent, 'sales.staff', 'Sales@123');
    const createReq = await staffAgent.post('/api/payment-requests').send({
      requestDate: '2026-03-29',
      expenseCategory: 'Stationery',
      description: 'Initial draft',
      lineItems: [{ description: 'Paper reams', quantity: 2, unitPriceNgn: 5000 }],
    });
    expect(createReq.status).toBe(201);
    const rid = createReq.body.requestID;
    const patch = await staffAgent.patch(`/api/payment-requests/${encodeURIComponent(rid)}`).send({
      requestDate: '2026-03-29',
      expenseCategory: 'Stationery',
      description: 'Updated by sales',
      lineItems: [{ description: 'Paper reams', quantity: 3, unitPriceNgn: 5000 }],
    });
    expect(patch.status).toBe(200);
    expect(patch.body?.ok).toBe(true);
  });

  it('sales officer PATCH cutting list is open before push; requires token after push', async () => {
    const staffAgent = request.agent(app);
    await loginAs(staffAgent, 'sales.staff', 'Sales@123');
    const created = await staffAgent.post('/api/cutting-lists').send({
      quotationRef: 'QT-2026-005',
      customerID: 'CUS-001',
      productID: 'FG-101',
      productName: 'Longspan thin',
      dateISO: '2026-03-29',
      machineName: 'Machine 01 (Longspan)',
      operatorName: 'Ibrahim',
      lines: [{ sheets: 1, lengthM: 6, lineType: 'Roof' }],
    });
    expect(created.status).toBe(201);
    const clId = created.body.id || created.body.cuttingList?.id;

    const openEdit = await staffAgent.patch(`/api/cutting-lists/${encodeURIComponent(clId)}`).send({
      machineName: 'Machine 02',
    });
    expect(openEdit.status).toBe(200);
    expect(openEdit.body?.ok).toBe(true);

    const job = await staffAgent.post('/api/production-jobs').send({
      cuttingListId: clId,
      productID: 'FG-101',
      productName: 'Longspan thin',
      plannedMeters: 6,
      plannedSheets: 1,
      status: 'Planned',
    });
    expect(job.status).toBe(201);

    const blocked = await staffAgent.patch(`/api/cutting-lists/${encodeURIComponent(clId)}`).send({
      machineName: 'Machine 03',
    });
    expect(blocked.status).toBe(403);
    expect(blocked.body?.code).toBe('EDIT_APPROVAL_REQUIRED');

    const mgrAgent = request.agent(app);
    await loginAs(mgrAgent, 'sales.manager', 'Sales@123');
    const reqTok = await staffAgent.post('/api/edit-approvals/request').send({
      entityKind: 'cutting_list',
      entityId: clId,
    });
    expect(reqTok.status).toBe(200);
    const tokenId = reqTok.body.approvalId || reqTok.body.approval?.id;
    const approved = await mgrAgent.post(`/api/edit-approvals/${encodeURIComponent(tokenId)}/approve`).send({});
    expect(approved.status).toBe(200);

    const patched = await staffAgent.patch(`/api/cutting-lists/${encodeURIComponent(clId)}`).send({
      machineName: 'Machine 03',
      editApprovalId: tokenId,
    });
    expect(patched.status).toBe(200);
    expect(patched.body?.ok).toBe(true);
  });

  it('POST /api/payment-requests/:requestId/pay records split treasury payout after approval', async () => {
    const before = await agent.get('/api/bootstrap');
    const [cashAccount, bankAccount] = before.body.treasuryAccounts.slice(0, 2);

    const expense = await agent.post('/api/expenses').send({
      expenseType: 'Diesel refill',
      amountNgn: 500_000,
      date: '2026-03-29',
      category: 'Rent & utilities',
      paymentMethod: 'Mixed',
      reference: 'EXP-DIESEL-1',
    });
    expect(expense.status).toBe(201);

    const requestCreate = await agent.post('/api/payment-requests').send({
      expenseID: expense.body.expenseID,
      amountRequestedNgn: 500_000,
      requestDate: '2026-03-29',
      description: 'Diesel payout split between cash and GT bank',
    });
    expect(requestCreate.status).toBe(201);

    const approve = await agent
      .post(`/api/payment-requests/${encodeURIComponent(requestCreate.body.requestID)}/decision`)
      .send({ status: 'Approved', note: 'Approved for split payout.' });
    expect(approve.status).toBe(200);

    const pay = await agent
      .post(`/api/payment-requests/${encodeURIComponent(requestCreate.body.requestID)}/pay`)
      .send({
        note: 'Cash 300,000 and GT bank 200,000',
        paymentLines: [
          { treasuryAccountId: cashAccount.id, amountNgn: 300_000, reference: 'CASH-DIESEL' },
          { treasuryAccountId: bankAccount.id, amountNgn: 200_000, reference: 'GT-DIESEL' },
        ],
      });
    expect(pay.status).toBe(201);
    expect(pay.body.ok).toBe(true);
    expect(pay.body.amountPaidNgn).toBe(500_000);
    expect(pay.body.fullyPaid).toBe(true);

    const after = await agent.get('/api/bootstrap');
    const reqRow = after.body.paymentRequests.find((r) => r.requestID === requestCreate.body.requestID);
    expect(reqRow.paidAmountNgn).toBe(500_000);
    expect(reqRow.paidBy).toBe('Zarewa Admin');
    expect(reqRow.paidAtISO).toBeTruthy();
    expect(
      after.body.treasuryMovements.filter(
        (m) => m.sourceKind === 'PAYMENT_REQUEST' && m.sourceId === requestCreate.body.requestID
      )
    ).toHaveLength(2);
  });

  it('POST /api/payment-requests/:requestId/pay rejects a second full payout when already paid', async () => {
    const before = await agent.get('/api/bootstrap');
    const cashAccount = before.body.treasuryAccounts[0];

    const expense = await agent.post('/api/expenses').send({
      expenseType: 'Duplicate pay guard',
      amountNgn: 25_000,
      date: '2026-03-29',
      category: 'Maintenance',
      paymentMethod: 'Cash',
      reference: 'EXP-DUP-PAY',
    });
    expect(expense.status).toBe(201);

    const requestCreate = await agent.post('/api/payment-requests').send({
      expenseID: expense.body.expenseID,
      amountRequestedNgn: 25_000,
      requestDate: '2026-03-29',
      description: 'Duplicate payout guard',
    });
    expect(requestCreate.status).toBe(201);

    const approve = await agent
      .post(`/api/payment-requests/${encodeURIComponent(requestCreate.body.requestID)}/decision`)
      .send({ status: 'Approved', note: 'ok' });
    expect(approve.status).toBe(200);

    const payOnce = await agent
      .post(`/api/payment-requests/${encodeURIComponent(requestCreate.body.requestID)}/pay`)
      .send({
        paymentLines: [{ treasuryAccountId: cashAccount.id, amountNgn: 25_000, reference: 'ONCE' }],
      });
    expect(payOnce.status).toBe(201);
    expect(payOnce.body.ok).toBe(true);

    const payAgain = await agent
      .post(`/api/payment-requests/${encodeURIComponent(requestCreate.body.requestID)}/pay`)
      .send({
        paymentLines: [{ treasuryAccountId: cashAccount.id, amountNgn: 25_000, reference: 'TWICE' }],
      });
    expect(payAgain.status).toBe(400);
    expect(payAgain.body.ok).toBe(false);
    expect(String(payAgain.body.error || '')).toMatch(/already fully paid/i);

    const after = await agent.get('/api/bootstrap');
    const reqRow = after.body.paymentRequests.find((r) => r.requestID === requestCreate.body.requestID);
    expect(reqRow.paidAmountNgn).toBe(25_000);
    expect(
      after.body.treasuryMovements.filter(
        (m) => m.sourceKind === 'PAYMENT_REQUEST' && m.sourceId === requestCreate.body.requestID
      )
    ).toHaveLength(1);
  });

  it('POST /api/payment-requests/:requestId/reverse-treasury-payout zeros paid and posts compensating movements', async () => {
    const before = await agent.get('/api/bootstrap');
    const cashAccount = before.body.treasuryAccounts[0];

    const expense = await agent.post('/api/expenses').send({
      expenseType: 'Test reversal',
      amountNgn: 50_000,
      date: '2026-03-29',
      category: 'Maintenance',
      paymentMethod: 'Cash',
      reference: 'EXP-REV-PR',
    });
    expect(expense.status).toBe(201);

    const requestCreate = await agent.post('/api/payment-requests').send({
      expenseID: expense.body.expenseID,
      amountRequestedNgn: 50_000,
      requestDate: '2026-03-29',
      description: 'Reversal test payout',
    });
    expect(requestCreate.status).toBe(201);

    const approve = await agent
      .post(`/api/payment-requests/${encodeURIComponent(requestCreate.body.requestID)}/decision`)
      .send({ status: 'Approved', note: 'ok' });
    expect(approve.status).toBe(200);

    const pay = await agent
      .post(`/api/payment-requests/${encodeURIComponent(requestCreate.body.requestID)}/pay`)
      .send({ treasuryAccountId: cashAccount.id, amountNgn: 50_000, note: 'pay out' });
    expect(pay.status).toBe(201);

    const rev = await agent
      .post(`/api/payment-requests/${encodeURIComponent(requestCreate.body.requestID)}/reverse-treasury-payout`)
      .send({ note: 'wrong batch' });
    expect(rev.status).toBe(200);
    expect(rev.body.ok).toBe(true);
    expect(Array.isArray(rev.body.movements)).toBe(true);
    expect(rev.body.movements.length).toBe(1);

    const after = await agent.get('/api/bootstrap');
    const reqRow = after.body.paymentRequests.find((r) => r.requestID === requestCreate.body.requestID);
    expect(reqRow.paidAmountNgn).toBe(0);

    const lines = after.body.treasuryMovements.filter(
      (m) => m.sourceKind === 'PAYMENT_REQUEST' && m.sourceId === requestCreate.body.requestID
    );
    const reversals = lines.filter((m) => m.type === 'PAYMENT_REQUEST_REVERSAL_IN');
    expect(reversals.length).toBe(1);
    expect(Number(reversals[0].amountNgn)).toBeGreaterThan(0);
  });

  it('refund request lifecycle requires approval before payout', async () => {
    const salesStaff = request.agent(app);
    await loginAs(salesStaff, 'sales.staff', 'Sales@123');
    const createRefund = await salesStaff.post('/api/refunds').send({
      ...REFUND_TEST_PAYEE,
      customerID: 'CUS-001',
      customer: 'Alhaji Musa & Sons',
      quotationRef: 'QT-2026-001',
      reasonCategory: 'Overpayment',
      reason: 'Overpayment - test',
      amountNgn: 12_500,
      calculationLines: [{ label: 'Test overpayment', amountNgn: 12_500 }],
    });
    expect(createRefund.status).toBe(201);

    const financeAgent = request.agent(app);
    await loginAs(financeAgent, 'finance.manager', 'Finance@123');
    const payBlocked = await financeAgent
      .post(`/api/refunds/${encodeURIComponent(createRefund.body.refundID)}/pay`)
      .send({ treasuryAccountId: 1, reference: 'RF-BLOCK' });
    expect(payBlocked.status).toBe(400);

    const managerAgent = request.agent(app);
    await loginAs(managerAgent, 'sales.manager', 'Sales@123');
    const approve = await managerAgent
      .post(`/api/refunds/${encodeURIComponent(createRefund.body.refundID)}/decision`)
      .send({
        status: 'Approved',
        approvalDate: '2026-03-29',
        managerComments: 'Approved after review.',
      });
    expect(approve.status).toBe(200);

    const pay = await financeAgent
      .post(`/api/refunds/${encodeURIComponent(createRefund.body.refundID)}/pay`)
      .send({ treasuryAccountId: 1, reference: 'RF-PAY' });
    expect(pay.status).toBe(201);

    const boot = await financeAgent.get('/api/bootstrap');
    const refund = boot.body.refunds.find((r) => r.refundID === createRefund.body.refundID);
    expect(refund.status).toBe('Paid');
    expect(refund.paidBy).toBe('Finance Manager');
  });

  it('refund payout posts REFUND_ADVANCE when customer has advance credit', async () => {
    const adv = await agent.post('/api/ledger/advance').send({
      customerID: 'CUS-001',
      amountNgn: 500_000,
      dateISO: '2026-03-27',
      purpose: 'Test advance before refund payout',
    });
    expect(adv.status).toBe(201);
    expect(adv.body.ok).toBe(true);

    const financeAgent = request.agent(app);
    await loginAs(financeAgent, 'finance.manager', 'Finance@123');

    const salesStaff = request.agent(app);
    await loginAs(salesStaff, 'sales.staff', 'Sales@123');
    const createRefund = await salesStaff.post('/api/refunds').send({
      ...REFUND_TEST_PAYEE,
      customerID: 'CUS-001',
      customer: 'Alhaji Musa & Sons',
      quotationRef: 'QT-2026-001',
      reasonCategory: 'Overpayment',
      reason: 'Partial return of credit',
      amountNgn: 80_000,
      calculationLines: [{ label: 'Credit return', amountNgn: 80_000 }],
    });
    expect(createRefund.status).toBe(201);

    const managerAgent = request.agent(app);
    await loginAs(managerAgent, 'sales.manager', 'Sales@123');
    const approve = await managerAgent
      .post(`/api/refunds/${encodeURIComponent(createRefund.body.refundID)}/decision`)
      .send({
        status: 'Approved',
        approvalDate: '2026-03-29',
        managerComments: 'OK',
      });
    expect(approve.status).toBe(200);

    const pay = await financeAgent
      .post(`/api/refunds/${encodeURIComponent(createRefund.body.refundID)}/pay`)
      .send({ treasuryAccountId: 1, reference: 'RF-ADV-LEDGER' });
    expect(pay.status).toBe(201);

    const boot = await financeAgent.get('/api/bootstrap');
    const refundAdvanceLines = boot.body.ledgerEntries.filter(
      (e) =>
        e.customerID === 'CUS-001' &&
        e.type === 'REFUND_ADVANCE' &&
        String(e.bankReference || '') === createRefund.body.refundID
    );
    expect(refundAdvanceLines.length).toBeGreaterThanOrEqual(1);
    expect(refundAdvanceLines[0].amountNgn).toBe(80_000);
  });

  it('period locks block backdated finance postings until unlocked', async () => {
    const lock = await agent.post('/api/controls/period-locks').send({
      periodKey: '2026-03',
      reason: 'Month-end close',
    });
    expect(lock.status).toBe(201);

    const blockedExpense = await agent.post('/api/expenses').send({
      expenseType: 'Blocked expense',
      amountNgn: 5_000,
      date: '2026-03-15',
      category: 'Rent & utilities',
      paymentMethod: 'Cash',
      treasuryAccountId: 1,
      reference: 'EXP-BLOCK',
    });
    expect(blockedExpense.status).toBe(400);
    expect(blockedExpense.body.error).toMatch(/locked period/i);

    const blockedGl = await agent.post('/api/gl/journal').send({
      entryDateISO: '2026-03-10',
      memo: 'Locked period test',
      lines: [
        { accountCode: '1000', debitNgn: 1_000 },
        { accountCode: '1200', creditNgn: 1_000 },
      ],
    });
    expect(blockedGl.status).toBe(400);
    expect(blockedGl.body.error).toMatch(/locked period/i);

    const unlock = await agent.delete('/api/controls/period-locks/2026-03').send({
      reason: 'Re-open for correction',
    });
    expect(unlock.status).toBe(200);

    const postedExpense = await agent.post('/api/expenses').send({
      expenseType: 'Released expense',
      amountNgn: 5_000,
      date: '2026-03-15',
      category: 'Rent & utilities',
      paymentMethod: 'Cash',
      treasuryAccountId: 1,
      reference: 'EXP-OPEN',
    });
    expect(postedExpense.status).toBe(201);
  });

  it('role permissions block non-finance users from finance posting endpoints', async () => {
    const procurementAgent = request.agent(app);
    await loginAs(procurementAgent, 'procurement', 'Procure@123');
    const res = await procurementAgent.post('/api/expenses').send({
      expenseType: 'Blocked',
      amountNgn: 1_000,
      date: '2026-03-29',
      category: 'Others',
      paymentMethod: 'Cash',
      treasuryAccountId: 1,
      reference: 'NOPE',
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });

  it('password change requires current password and allows re-login', async () => {
    const financeAgent = request.agent(app);
    await loginAs(financeAgent, 'finance.manager', 'Finance@123');

    const changed = await financeAgent.post('/api/session/change-password').send({
      currentPassword: 'Finance@123',
      newPassword: 'Finance@New456!',
    });
    expect(changed.status).toBe(200);

    const relogin = await request(app).post('/api/session/login').send({
      username: 'finance.manager',
      password: 'Finance@New456!',
    });
    expect(relogin.status).toBe(200);
  });

  it('audit log endpoint is available to finance approval roles', async () => {
    const financeAgent = request.agent(app);
    await loginAs(financeAgent, 'finance.manager', 'Finance@123');
    const res = await financeAgent.get('/api/audit-log');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.auditLog)).toBe(true);
  });

  async function seedTwoCoilsForProduction(client) {
    const sup = await client.post('/api/suppliers').send({ name: 'Traceability Supplier', city: 'Kano' });
    expect(sup.status).toBe(201);
    const po = await client.post('/api/purchase-orders').send({
      supplierID: sup.body.supplierID,
      supplierName: 'Traceability Supplier',
      orderDateISO: '2026-03-29',
      expectedDeliveryISO: '',
      status: 'Approved',
      lines: [
        {
          lineKey: 'L-TR',
          productID: 'COIL-ALU',
          productName: 'Aluminium coil (kg)',
          color: 'IV',
          gauge: '0.24',
          metersOffered: 1327,
          conversionKgPerM: 3000 / 1327,
          qtyOrdered: 6000,
          unitPricePerKgNgn: 100,
          unitPriceNgn: 100,
          qtyReceived: 0,
        },
      ],
    });
    expect(po.status).toBe(201);
    const grn1 = await client.post(`/api/purchase-orders/${encodeURIComponent(po.body.poID)}/grn`).send({
      entries: [
        {
          lineKey: 'L-TR',
          productID: 'COIL-ALU',
          qtyReceived: 3000,
          weightKg: 3000,
          coilNo: 'CL-API-TR-A',
          location: 'Bay 1',
          gaugeLabel: '0.24mm',
          materialTypeName: 'Aluminium',
          supplierExpectedMeters: 1327,
          supplierConversionKgPerM: 3000 / 1327,
        },
        {
          lineKey: 'L-TR',
          productID: 'COIL-ALU',
          qtyReceived: 3000,
          weightKg: 3000,
          coilNo: 'CL-API-TR-B',
          location: 'Bay 1',
          gaugeLabel: '0.24mm',
          materialTypeName: 'Aluminium',
          supplierExpectedMeters: 1327,
          supplierConversionKgPerM: 3000 / 1327,
        },
      ],
      supplierID: sup.body.supplierID,
      supplierName: 'Traceability Supplier',
    });
    expect(grn1.status).toBe(200);
    return { coilA: 'CL-API-TR-A', coilB: 'CL-API-TR-B' };
  }

  it('production job start is blocked until coil allocations exist', async () => {
    const { coilA } = await seedTwoCoilsForProduction(agent);
    const cutting = await agent.post('/api/cutting-lists').send({
      quotationRef: 'QT-2026-005',
      customerID: 'CUS-001',
      productID: 'FG-101',
      productName: 'Longspan thin',
      dateISO: '2026-03-29',
      machineName: 'Machine 01',
      operatorName: 'QA',
      lines: [{ sheets: 2, lengthM: 10 }],
    });
    expect(cutting.status).toBe(201);
    const job = await agent.post('/api/production-jobs').send({
      cuttingListId: cutting.body.id,
      productID: 'FG-101',
      productName: 'Longspan thin',
      plannedMeters: 20,
      plannedSheets: 2,
      status: 'Planned',
    });
    expect(job.status).toBe(201);
    const blocked = await agent.post(`/api/production-jobs/${encodeURIComponent(job.body.jobID)}/start`).send({});
    expect(blocked.status).toBe(400);
    expect(blocked.body.error).toMatch(/allocat/i);

    const alloc = await agent.post(`/api/production-jobs/${encodeURIComponent(job.body.jobID)}/allocations`).send({
      allocations: [{ coilNo: coilA, openingWeightKg: 500 }],
    });
    expect(alloc.status).toBe(200);
    const started = await agent.post(`/api/production-jobs/${encodeURIComponent(job.body.jobID)}/start`).send({
      startedAtISO: '2026-03-29',
    });
    expect(started.status).toBe(200);
  });

  it('POST /api/production-jobs/:jobId/cancel marks planned job Cancelled and blocks restart', async () => {
    const cutting = await agent.post('/api/cutting-lists').send({
      quotationRef: 'QT-2026-005',
      customerID: 'CUS-001',
      productID: 'FG-101',
      productName: 'Longspan thin',
      dateISO: '2026-03-29',
      machineName: 'Machine 01',
      operatorName: 'QA',
      lines: [{ sheets: 1, lengthM: 5 }],
    });
    expect(cutting.status).toBe(201);
    const job = await agent.post('/api/production-jobs').send({
      cuttingListId: cutting.body.id,
      productID: 'FG-101',
      productName: 'Longspan thin',
      plannedMeters: 10,
      plannedSheets: 1,
    });
    expect(job.status).toBe(201);
    const jobId = job.body.jobID;
    const cancel = await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/cancel`).send({
      reason: 'Order cancelled — no run needed (QA test)',
    });
    expect(cancel.status).toBe(200);
    expect(cancel.body.ok).toBe(true);
    const boot = await agent.get('/api/bootstrap');
    const j = boot.body.productionJobs.find((x) => x.jobID === jobId);
    expect(j?.status).toBe('Cancelled');
    const clAfter = boot.body.cuttingLists.find((x) => x.id === cutting.body.id);
    expect(clAfter?.productionRegistered).toBe(false);
    expect(String(clAfter?.productionRegisterRef ?? '')).toBe('');
    const requeue = await agent.post('/api/production-jobs').send({
      cuttingListId: cutting.body.id,
      productID: 'FG-101',
      productName: 'Longspan thin',
      plannedMeters: 10,
      plannedSheets: 1,
    });
    expect(requeue.status).toBe(201);
    const badStart = await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/start`).send({});
    expect(badStart.status).toBe(400);
    expect(String(badStart.body.error || '')).toMatch(/cancel/i);
  });

  it('GET /api/production-jobs/:jobId/coil-allocations lists allocations and 404s missing jobs', async () => {
    const { coilA } = await seedTwoCoilsForProduction(agent);
    const cutting = await agent.post('/api/cutting-lists').send({
      quotationRef: 'QT-2026-005',
      customerID: 'CUS-001',
      productID: 'FG-101',
      productName: 'Longspan thin',
      dateISO: '2026-03-29',
      machineName: 'Machine 01',
      operatorName: 'QA',
      lines: [{ sheets: 1, lengthM: 5 }],
    });
    expect(cutting.status).toBe(201);
    const job = await agent.post('/api/production-jobs').send({
      cuttingListId: cutting.body.id,
      productID: 'FG-101',
      productName: 'Longspan thin',
      plannedMeters: 10,
      plannedSheets: 1,
      status: 'Planned',
    });
    expect(job.status).toBe(201);
    const jobId = job.body.jobID;
    const miss = await agent.get(`/api/production-jobs/${encodeURIComponent('NO-SUCH-JOB')}/coil-allocations`);
    expect(miss.status).toBe(404);
    const empty = await agent.get(`/api/production-jobs/${encodeURIComponent(jobId)}/coil-allocations`);
    expect(empty.status).toBe(200);
    expect(empty.body.ok).toBe(true);
    expect(empty.body.allocations).toEqual([]);
    await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/allocations`).send({
      allocations: [{ coilNo: coilA, openingWeightKg: 250 }],
    });
    const filled = await agent.get(`/api/production-jobs/${encodeURIComponent(jobId)}/coil-allocations`);
    expect(filled.status).toBe(200);
    expect(filled.body.allocations).toHaveLength(1);
    expect(filled.body.allocations[0].coilNo).toBe(coilA);
    expect(filled.body.allocations[0].openingWeightKg).toBe(250);
  });

  it('multi-coil job supports conversion preview with four reference fields', async () => {
    const { coilA, coilB } = await seedTwoCoilsForProduction(agent);
    const cutting = await agent.post('/api/cutting-lists').send({
      quotationRef: 'QT-2026-005',
      customerID: 'CUS-001',
      productID: 'FG-101',
      productName: 'Longspan thin',
      dateISO: '2026-03-29',
      machineName: 'Machine 01',
      operatorName: 'QA',
      lines: [{ sheets: 4, lengthM: 5 }],
    });
    expect(cutting.status).toBe(201);
    const job = await agent.post('/api/production-jobs').send({
      cuttingListId: cutting.body.id,
      productID: 'FG-101',
      productName: 'Longspan thin',
      plannedMeters: 20,
      plannedSheets: 4,
      status: 'Planned',
    });
    expect(job.status).toBe(201);
    const jobId = job.body.jobID;
    const alloc = await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/allocations`).send({
      allocations: [
        { coilNo: coilA, openingWeightKg: 1500 },
        { coilNo: coilB, openingWeightKg: 1500 },
      ],
    });
    expect(alloc.status).toBe(200);
    await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/start`).send({ startedAtISO: '2026-03-29' });

    const prev = await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/conversion-preview`).send({
      allocations: [
        { coilNo: coilA, closingWeightKg: 520, metersProduced: 433 },
        { coilNo: coilB, closingWeightKg: 520, metersProduced: 433 },
      ],
    });
    expect(prev.status).toBe(200);
    expect(prev.body.rows).toHaveLength(2);
    const row0 = prev.body.rows[0];
    expect(row0.allocationId).toBeTruthy();
    expect(prev.body.rows[1].allocationId).toBeTruthy();
    expect(row0.standardConversionKgPerM).toBeGreaterThan(0);
    expect(row0.supplierConversionKgPerM).toBeGreaterThan(0);
    expect(row0).toHaveProperty('variances');

    const listAlloc = await agent.get(`/api/production-jobs/${encodeURIComponent(jobId)}/coil-allocations`);
    expect(listAlloc.status).toBe(200);
    const allocRows = listAlloc.body.allocations;
    expect(allocRows).toHaveLength(2);
    const byId = await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/conversion-preview`).send({
      allocations: [
        {
          allocationId: allocRows[0].id,
          coilNo: coilA,
          closingWeightKg: 520,
          metersProduced: 433,
        },
        {
          allocationId: allocRows[1].id,
          coilNo: coilB,
          closingWeightKg: 520,
          metersProduced: 433,
        },
      ],
    });
    expect(byId.status).toBe(200);
    expect(byId.body.rows).toHaveLength(2);
  });

  it('coil completion with offcutInventoryMeters updates FG, actualMeters, and preview totalOutputMeters', async () => {
    const { coilA } = await seedTwoCoilsForProduction(agent);
    const cutting = await agent.post('/api/cutting-lists').send({
      quotationRef: 'QT-2026-005',
      customerID: 'CUS-001',
      productID: 'FG-101',
      productName: 'Longspan thin',
      dateISO: '2026-03-29',
      machineName: 'M1',
      operatorName: 'QA',
      lines: [{ sheets: 1, lengthM: 120 }],
    });
    expect(cutting.status).toBe(201);
    const job = await agent.post('/api/production-jobs').send({
      cuttingListId: cutting.body.id,
      productID: 'FG-101',
      productName: 'Longspan thin',
      plannedMeters: 120,
      plannedSheets: 1,
      status: 'Planned',
    });
    expect(job.status).toBe(201);
    const jobId = job.body.jobID;
    const alloc = await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/allocations`).send({
      allocations: [{ coilNo: coilA, openingWeightKg: 800 }],
    });
    expect(alloc.status).toBe(200);
    const allocationId = alloc.body.allocations[0].id;
    await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/start`).send({ startedAtISO: '2026-03-29' });

    const prev = await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/conversion-preview`).send({
      allocations: [
        {
          allocationId,
          coilNo: coilA,
          closingWeightKg: 400,
          metersProduced: 100,
          finishCoil: false,
        },
      ],
      offcutInventoryMeters: 2,
    });
    expect(prev.status).toBe(200);
    expect(prev.body.totalMeters).toBeCloseTo(100, 3);
    expect(prev.body.totalOutputMeters).toBeCloseTo(102, 3);
    expect(prev.body.offcutInventoryMeters).toBeCloseTo(2, 3);

    const bootBefore = await agent.get('/api/bootstrap');
    const fgBefore = Number(bootBefore.body.products.find((p) => p.productID === 'FG-101')?.stockLevel ?? 0);

    const done = await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/complete`).send({
      completedAtISO: '2026-03-29',
      allocations: [
        {
          allocationId,
          coilNo: coilA,
          closingWeightKg: 400,
          metersProduced: 100,
          finishCoil: false,
        },
      ],
      offcutInventoryMeters: 2,
    });
    expect(done.status).toBe(200);
    expect(done.body.actualMeters).toBeCloseTo(102, 3);

    const bootAfter = await agent.get('/api/bootstrap');
    const pj = bootAfter.body.productionJobs.find((j) => j.jobID === jobId);
    expect(pj?.status).toBe('Completed');
    expect(pj.actualMeters).toBeCloseTo(102, 3);
    expect(pj.offcutInventoryMeters).toBeCloseTo(2, 3);
    const fgAfter = Number(bootAfter.body.products.find((p) => p.productID === 'FG-101')?.stockLevel ?? 0);
    expect(fgAfter).toBeCloseTo(fgBefore + 102, 2);
  });

  it('rejects offcutInventoryMeters when no coil metres are produced (use offcut-only completion instead)', async () => {
    const { coilA } = await seedTwoCoilsForProduction(agent);
    const cutting = await agent.post('/api/cutting-lists').send({
      quotationRef: 'QT-2026-005',
      customerID: 'CUS-001',
      productID: 'FG-101',
      productName: 'Longspan thin',
      dateISO: '2026-03-29',
      machineName: 'M1',
      operatorName: 'QA',
      lines: [{ sheets: 1, lengthM: 20 }],
    });
    expect(cutting.status).toBe(201);
    const job = await agent.post('/api/production-jobs').send({
      cuttingListId: cutting.body.id,
      productID: 'FG-101',
      productName: 'Longspan thin',
      plannedMeters: 20,
      plannedSheets: 1,
      status: 'Planned',
    });
    expect(job.status).toBe(201);
    const jobId = job.body.jobID;
    const alloc = await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/allocations`).send({
      allocations: [{ coilNo: coilA, openingWeightKg: 800 }],
    });
    expect(alloc.status).toBe(200);
    const allocationId = alloc.body.allocations[0].id;
    await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/start`).send({ startedAtISO: '2026-03-29' });

    const bad = await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/complete`).send({
      completedAtISO: '2026-03-29',
      allocations: [
        {
          allocationId,
          coilNo: coilA,
          closingWeightKg: 800,
          metersProduced: 0,
          finishCoil: false,
        },
      ],
      offcutInventoryMeters: 2,
    });
    expect(bad.status).toBe(400);
    /** `computeCompletionConversionRows` rejects zero metres before the mixed-run offcut guard runs. */
    expect(String(bad.body.error || '')).toMatch(/positive number of metres|offcut|coil/i);
  });

  it('requires meterOverrunRemark when coil plus offcutInventoryMeters exceeds planned metres', async () => {
    const { coilA } = await seedTwoCoilsForProduction(agent);
    const cutting = await agent.post('/api/cutting-lists').send({
      quotationRef: 'QT-2026-005',
      customerID: 'CUS-001',
      productID: 'FG-101',
      productName: 'Longspan thin',
      dateISO: '2026-03-29',
      machineName: 'M1',
      operatorName: 'QA',
      lines: [{ sheets: 1, lengthM: 12 }],
    });
    expect(cutting.status).toBe(201);
    const job = await agent.post('/api/production-jobs').send({
      cuttingListId: cutting.body.id,
      productID: 'FG-101',
      productName: 'Longspan thin',
      plannedMeters: 12,
      plannedSheets: 1,
      status: 'Planned',
    });
    expect(job.status).toBe(201);
    const jobId = job.body.jobID;
    const alloc = await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/allocations`).send({
      allocations: [{ coilNo: coilA, openingWeightKg: 800 }],
    });
    expect(alloc.status).toBe(200);
    const allocationId = alloc.body.allocations[0].id;
    await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/start`).send({ startedAtISO: '2026-03-29' });

    const overNoRemark = await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/complete`).send({
      completedAtISO: '2026-03-29',
      allocations: [
        {
          allocationId,
          coilNo: coilA,
          closingWeightKg: 400,
          metersProduced: 100,
          finishCoil: false,
        },
      ],
      offcutInventoryMeters: 3,
    });
    expect(overNoRemark.status).toBe(400);
    expect(String(overNoRemark.body.error || '')).toMatch(/overrun|remark|planned/i);

    const overOk = await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/complete`).send({
      completedAtISO: '2026-03-29',
      allocations: [
        {
          allocationId,
          coilNo: coilA,
          closingWeightKg: 400,
          metersProduced: 100,
          finishCoil: false,
        },
      ],
      offcutInventoryMeters: 3,
      meterOverrunRemark: 'Manager approved overrun — site measure exceeded cutting list.',
    });
    expect(overOk.status).toBe(200);
    expect(overOk.body.actualMeters).toBeCloseTo(103, 3);
  });

  it('completion-coil-corrections sets actual_meters to coil sum plus stored offcutInventoryMeters', async () => {
    const { coilA } = await seedTwoCoilsForProduction(agent);
    const cutting = await agent.post('/api/cutting-lists').send({
      quotationRef: 'QT-2026-005',
      customerID: 'CUS-001',
      productID: 'FG-101',
      productName: 'Longspan thin',
      dateISO: '2026-03-29',
      machineName: 'M1',
      operatorName: 'QA',
      lines: [{ sheets: 1, lengthM: 200 }],
    });
    expect(cutting.status).toBe(201);
    const job = await agent.post('/api/production-jobs').send({
      cuttingListId: cutting.body.id,
      productID: 'FG-101',
      productName: 'Longspan thin',
      plannedMeters: 200,
      plannedSheets: 1,
      status: 'Planned',
    });
    expect(job.status).toBe(201);
    const jobId = job.body.jobID;
    const alloc = await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/allocations`).send({
      allocations: [{ coilNo: coilA, openingWeightKg: 800 }],
    });
    expect(alloc.status).toBe(200);
    const allocationId = alloc.body.allocations[0].id;
    await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/start`).send({ startedAtISO: '2026-03-29' });
    const complete = await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/complete`).send({
      completedAtISO: '2026-03-29',
      allocations: [
        {
          allocationId,
          coilNo: coilA,
          closingWeightKg: 400,
          metersProduced: 100,
          finishCoil: false,
        },
      ],
      offcutInventoryMeters: 2,
    });
    expect(complete.status).toBe(200);

    const list = await agent.get(`/api/production-jobs/${encodeURIComponent(jobId)}/coil-allocations`);
    expect(list.status).toBe(200);
    const line = list.body.allocations[0];
    const corr = await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/completion-coil-corrections`).send({
      reason: 'Operator mistyped metre reading on completion form — corrected after yard recount.',
      readings: [
        {
          allocationId: line.id,
          coilNo: line.coilNo,
          openingWeightKg: line.openingWeightKg,
          closingWeightKg: line.closingWeightKg,
          metersProduced: 90,
        },
      ],
    });
    expect(corr.status).toBe(200);

    const boot = await agent.get('/api/bootstrap');
    const pj = boot.body.productionJobs.find((j) => j.jobID === jobId);
    expect(pj.actualMeters).toBeCloseTo(92, 3);
    expect(pj.offcutInventoryMeters).toBeCloseTo(2, 3);

    const listAfter = await agent.get(`/api/production-jobs/${encodeURIComponent(jobId)}/coil-allocations`);
    expect(listAfter.status).toBe(200);
    const line2 = listAfter.body.allocations[0];
    const corrOff = await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/completion-coil-corrections`).send({
      reason: 'Additional offcut stock metres were issued from yard after completion audit.',
      readings: [
        {
          allocationId: line2.id,
          coilNo: line2.coilNo,
          openingWeightKg: line2.openingWeightKg,
          closingWeightKg: line2.closingWeightKg,
          metersProduced: line2.metersProduced,
        },
      ],
      offcutInventoryMeters: 4,
    });
    expect(corrOff.status).toBe(200);
    const boot2 = await agent.get('/api/bootstrap');
    const pj2 = boot2.body.productionJobs.find((j) => j.jobID === jobId);
    expect(pj2.actualMeters).toBeCloseTo(94, 3);
    expect(pj2.offcutInventoryMeters).toBeCloseTo(4, 3);
  });

  it('coil split, scrap, and return-material update lots, lineage, and stock movements', async () => {
    const { coilA } = await seedTwoCoilsForProduction(agent);
    const d = '2026-03-29';

    const split = await agent.post(`/api/coil-lots/${encodeURIComponent(coilA)}/split`).send({
      splitKg: 400,
      note: 'Off-cut line',
      dateISO: d,
    });
    expect(split.status).toBe(200);
    expect(split.body.ok).toBe(true);
    const child = split.body.newCoilNo;
    expect(child && String(child).length).toBeGreaterThan(3);

    const boot1 = await agent.get('/api/bootstrap');
    expect(boot1.status).toBe(200);
    const lotA = boot1.body.coilLots.find((c) => c.coilNo === coilA);
    const lotC = boot1.body.coilLots.find((c) => c.coilNo === child);
    expect(lotA.qtyRemaining).toBeCloseTo(2600, 1);
    expect(lotC.qtyRemaining).toBeCloseTo(400, 1);
    expect(lotC.parentCoilNo).toBe(coilA);

    const scrap = await agent.post(`/api/coil-lots/${encodeURIComponent(coilA)}/scrap`).send({
      kg: 100,
      reason: 'Damage',
      note: 'Edge crush',
      dateISO: d,
      creditScrapInventory: true,
      scrapProductID: 'SCRAP-COIL',
    });
    expect(scrap.status).toBe(200);
    expect(scrap.body.ok).toBe(true);

    const boot2 = await agent.get('/api/bootstrap');
    const scrapProd = boot2.body.products.find((p) => p.productID === 'SCRAP-COIL');
    expect(scrapProd).toBeTruthy();
    expect(Number(scrapProd.stockLevel)).toBeGreaterThanOrEqual(99.9);
    expect(Array.isArray(boot2.body.coilControlEvents)).toBe(true);
    const scrapEv = boot2.body.coilControlEvents.find((e) => e.eventKind === 'scrap_offcut' && e.coilNo === coilA);
    expect(scrapEv).toBeTruthy();
    expect(Number(scrapEv.kgCoilDelta)).toBeCloseTo(-100, 3);

    const ret = await agent.post(`/api/coil-lots/${encodeURIComponent(coilA)}/return-material`).send({
      kg: 50,
      reason: 'Weighbridge / count correction',
      dateISO: d,
    });
    expect(ret.status).toBe(200);
    expect(ret.body.ok).toBe(true);

    const boot3 = await agent.get('/api/bootstrap');
    const lotA2 = boot3.body.coilLots.find((c) => c.coilNo === coilA);
    expect(lotA2.qtyRemaining).toBeCloseTo(2550, 1);
    const addEv = boot3.body.coilControlEvents.find((e) => e.eventKind === 'adjust_add_kg' && e.coilNo === coilA);
    expect(addEv).toBeTruthy();
    expect(Number(addEv.kgCoilDelta)).toBeCloseTo(50, 3);
  });

  it('coil-lots finish-roll clears near-finished tail from stock', async () => {
    const { coilA } = await seedTwoCoilsForProduction(agent);
    const d = '2026-03-30';
    const split = await agent.post(`/api/coil-lots/${encodeURIComponent(coilA)}/split`).send({
      splitKg: 85,
      note: 'Tail test child',
      dateISO: d,
    });
    expect(split.status).toBe(200);
    const child = split.body.newCoilNo;
    expect(child).toBeTruthy();

    const finish = await agent.post(`/api/coil-lots/${encodeURIComponent(child)}/finish-roll`).send({
      note: 'Missed roll finished at CL-55 completion — tail cleared for stock verify',
      cuttingListRef: 'CL-55',
      dateISO: d,
    });
    expect(finish.status).toBe(200);
    expect(finish.body.ok).toBe(true);
    expect(finish.body.tailKgCleared).toBeCloseTo(85, 1);

    const boot = await agent.get('/api/bootstrap');
    const lot = boot.body.coilLots.find((c) => c.coilNo === child);
    expect(lot.qtyRemaining).toBeCloseTo(0, 2);
    expect(String(lot.currentStatus || '').toLowerCase()).toBe('consumed');
    const ev = boot.body.coilControlEvents.find((e) => e.eventKind === 'finish_roll' && e.coilNo === child);
    expect(ev).toBeTruthy();
    expect(Number(ev.kgCoilDelta)).toBeCloseTo(-85, 1);
  });

  it('coil-lots PATCH master-data updates metadata for branch manager; sales staff forbidden', async () => {
    const { coilA } = await seedTwoCoilsForProduction(agent);
    const mgr = request.agent(app);
    await loginAs(mgr, 'sales.manager', 'Sales@123');
    const patch = await mgr.patch(`/api/coil-lots/${encodeURIComponent(coilA)}/master-data`).send({
      colour: 'RAL 9005',
      gaugeLabel: '0.50 mm',
      materialTypeName: 'Alu zinc',
      receivedKg: 3100,
    });
    expect(patch.status).toBe(200);
    expect(patch.body.ok).toBe(true);

    const boot = await mgr.get('/api/bootstrap');
    const lot = boot.body.coilLots.find((c) => c.coilNo === coilA);
    expect(lot.colour).toBe('RAL 9005');
    expect(lot.gaugeLabel).toBe('0.50 mm');
    expect(lot.materialTypeName).toBe('Alu zinc');
    expect(Number(lot.qtyReceived)).toBeCloseTo(3100, 2);

    const staff = request.agent(app);
    await loginAs(staff, 'sales.staff', 'Sales@123');
    const denied = await staff.patch(`/api/coil-lots/${encodeURIComponent(coilA)}/master-data`).send({ colour: 'X' });
    expect(denied.status).toBe(403);
  });

  it('coil-lots PATCH master-data can set current on-hand kg with stock and control events', async () => {
    const { coilA } = await seedTwoCoilsForProduction(agent);
    const mgr = request.agent(app);
    await loginAs(mgr, 'sales.manager', 'Sales@123');
    const boot0 = await mgr.get('/api/bootstrap');
    const lot0 = boot0.body.coilLots.find((c) => c.coilNo === coilA);
    const prod0 = boot0.body.products.find((p) => p.productID === 'COIL-ALU');
    expect(lot0).toBeTruthy();
    expect(prod0).toBeTruthy();
    const stock0 = Number(prod0.stockLevel);
    const rem0 = Number(lot0.currentWeightKg || lot0.qtyRemaining);
    const patch = await mgr.patch(`/api/coil-lots/${encodeURIComponent(coilA)}/master-data`).send({
      colour: lot0.colour,
      gaugeLabel: lot0.gaugeLabel,
      materialTypeName: lot0.materialTypeName,
      currentWeightKg: rem0 - 25,
    });
    expect(patch.status).toBe(200);
    expect(patch.body.ok).toBe(true);

    const boot1 = await mgr.get('/api/bootstrap');
    const lot1 = boot1.body.coilLots.find((c) => c.coilNo === coilA);
    const prod1 = boot1.body.products.find((p) => p.productID === 'COIL-ALU');
    expect(Number(lot1.currentWeightKg)).toBeCloseTo(rem0 - 25, 2);
    expect(Number(prod1.stockLevel)).toBeCloseTo(stock0 - 25, 2);
    const ev = boot1.body.coilControlEvents.find(
      (e) => e.eventKind === 'adjust_remove_kg' && e.coilNo === coilA
    );
    expect(ev).toBeTruthy();
    expect(Number(ev.kgCoilDelta)).toBeCloseTo(-25, 2);
  });

  it('one coil can back two production jobs with separate allocations', async () => {
    const sup = await agent.post('/api/suppliers').send({ name: 'Shared Coil Supplier', city: 'Abuja' });
    expect(sup.status).toBe(201);
    const po = await agent.post('/api/purchase-orders').send({
      supplierID: sup.body.supplierID,
      supplierName: 'Shared Coil Supplier',
      orderDateISO: '2026-03-29',
      expectedDeliveryISO: '',
      status: 'Approved',
      lines: [
        {
          lineKey: 'L-SH',
          productID: 'COIL-ALU',
          productName: 'Aluminium coil (kg)',
          color: 'IV',
          gauge: '0.24',
          metersOffered: 4400,
          conversionKgPerM: 10000 / 4400,
          qtyOrdered: 10000,
          unitPricePerKgNgn: 100,
          unitPriceNgn: 100,
          qtyReceived: 0,
        },
      ],
    });
    expect(po.status).toBe(201);
    const grn = await agent.post(`/api/purchase-orders/${encodeURIComponent(po.body.poID)}/grn`).send({
      entries: [
        {
          lineKey: 'L-SH',
          productID: 'COIL-ALU',
          qtyReceived: 10000,
          weightKg: 10000,
          coilNo: 'CL-API-SHARED',
          location: 'Main',
          gaugeLabel: '0.24mm',
          materialTypeName: 'Aluminium',
          supplierExpectedMeters: 4400,
          supplierConversionKgPerM: 10000 / 4400,
        },
      ],
      supplierID: sup.body.supplierID,
      supplierName: 'Shared Coil Supplier',
    });
    expect(grn.status).toBe(200);

    async function jobForCutting(qtRef, meters) {
      const cl = await agent.post('/api/cutting-lists').send({
        quotationRef: qtRef,
        customerID: 'CUS-001',
        productID: 'FG-101',
        productName: 'Longspan thin',
        dateISO: '2026-03-29',
        machineName: 'M1',
        operatorName: 'QA',
        lines: [{ sheets: 1, lengthM: meters }],
      });
      expect(cl.status).toBe(201);
      const pj = await agent.post('/api/production-jobs').send({
        cuttingListId: cl.body.id,
        productID: 'FG-101',
        productName: 'Longspan thin',
        plannedMeters: meters,
        plannedSheets: 1,
        status: 'Planned',
      });
      expect(pj.status).toBe(201);
      return pj.body.jobID;
    }

    const job1 = await jobForCutting('QT-2026-005', 12);
    const job2 = await jobForCutting('QT-2026-006', 8);
    const a1 = await agent.post(`/api/production-jobs/${encodeURIComponent(job1)}/allocations`).send({
      allocations: [{ coilNo: 'CL-API-SHARED', openingWeightKg: 4000 }],
    });
    expect(a1.status).toBe(200);
    const a2 = await agent.post(`/api/production-jobs/${encodeURIComponent(job2)}/allocations`).send({
      allocations: [{ coilNo: 'CL-API-SHARED', openingWeightKg: 3000 }],
    });
    expect(a2.status).toBe(200);
    const boot = await agent.get('/api/bootstrap');
    const coils = boot.body.productionJobCoils.filter((c) => c.coilNo === 'CL-API-SHARED');
    expect(coils.length).toBe(2);
  });

  it('GET production-holders and POST reconcile-reservation fix orphan qty_reserved', async () => {
    const coilNo = 'CL-API-ORPHAN-RES';
    const sup = await agent.post('/api/suppliers').send({ name: 'Orphan Res Supplier', city: 'Kano' });
    expect(sup.status).toBe(201);
    const po = await agent.post('/api/purchase-orders').send({
      supplierID: sup.body.supplierID,
      supplierName: 'Orphan Res Supplier',
      orderDateISO: '2026-03-29',
      expectedDeliveryISO: '',
      status: 'Approved',
      lines: [
        {
          lineKey: 'L-OR',
          productID: 'COIL-ALU',
          productName: 'Aluminium coil',
          qtyOrdered: 5000,
          unitPricePerKgNgn: 100,
          unitPriceNgn: 100,
          qtyReceived: 0,
        },
      ],
    });
    expect(po.status).toBe(201);
    await agent.post(`/api/purchase-orders/${encodeURIComponent(po.body.poID)}/grn`).send({
      entries: [
        {
          lineKey: 'L-OR',
          productID: 'COIL-ALU',
          qtyReceived: 5000,
          weightKg: 5000,
          coilNo,
          location: 'Bay',
        },
      ],
      supplierID: sup.body.supplierID,
      supplierName: 'Orphan Res Supplier',
    });
    const cl = await agent.post('/api/cutting-lists').send({
      quotationRef: 'QT-2026-005',
      customerID: 'CUS-001',
      productID: 'FG-101',
      productName: 'Longspan thin',
      dateISO: '2026-03-29',
      machineName: 'M1',
      operatorName: 'QA',
      lines: [{ sheets: 1, lengthM: 10 }],
    });
    expect(cl.status).toBe(201);
    const pj = await agent.post('/api/production-jobs').send({
      cuttingListId: cl.body.id,
      productID: 'FG-101',
      productName: 'Longspan thin',
      plannedMeters: 10,
      plannedSheets: 1,
      status: 'Planned',
    });
    expect(pj.status).toBe(201);
    const alloc = await agent.post(`/api/production-jobs/${encodeURIComponent(pj.body.jobID)}/allocations`).send({
      allocations: [{ coilNo, openingWeightKg: 800 }],
    });
    expect(alloc.status).toBe(200);
    db.prepare(`UPDATE coil_lots SET qty_reserved = 5000 WHERE coil_no = ?`).run(coilNo);
    const holders = await agent.get(`/api/coil-lots/${encodeURIComponent(coilNo)}/production-holders`);
    expect(holders.status).toBe(200);
    expect(holders.body.orphanReservedKg).toBeGreaterThan(4000);
    expect(holders.body.expectedReservedKg).toBe(800);
    const fix = await agent.post(`/api/coil-lots/${encodeURIComponent(coilNo)}/reconcile-reservation`).send({});
    expect(fix.status).toBe(200);
    expect(fix.body.freedKg).toBeGreaterThan(4000);
    expect(fix.body.qtyReservedAfter).toBe(800);
    const boot = await agent.get('/api/bootstrap');
    const lot = boot.body.coilLots.find((c) => c.coilNo === coilNo);
    expect(lot.qtyReserved).toBe(800);
  });

  it('conversion preview flags manager review when actual yield breaches references', async () => {
    const sup = await agent.post('/api/suppliers').send({ name: 'Alert Coil Supplier', city: 'Kano' });
    expect(sup.status).toBe(201);
    const po = await agent.post('/api/purchase-orders').send({
      supplierID: sup.body.supplierID,
      supplierName: 'Alert Coil Supplier',
      orderDateISO: '2026-03-29',
      expectedDeliveryISO: '',
      status: 'Approved',
      lines: [
        {
          lineKey: 'L-AL',
          productID: 'COIL-ALU',
          productName: 'Aluminium coil (kg)',
          color: 'IV',
          gauge: '0.24',
          metersOffered: 2650,
          conversionKgPerM: 6000 / 2650,
          qtyOrdered: 6000,
          unitPricePerKgNgn: 100,
          unitPriceNgn: 100,
          qtyReceived: 0,
        },
      ],
    });
    expect(po.status).toBe(201);
    await agent.post(`/api/purchase-orders/${encodeURIComponent(po.body.poID)}/grn`).send({
      entries: [
        {
          lineKey: 'L-AL',
          productID: 'COIL-ALU',
          qtyReceived: 6000,
          weightKg: 6000,
          coilNo: 'CL-API-ALERT',
          location: 'Bay',
          gaugeLabel: '0.24mm',
          materialTypeName: 'Aluminium',
          supplierExpectedMeters: 2650,
          supplierConversionKgPerM: 6000 / 2650,
        },
      ],
      supplierID: sup.body.supplierID,
      supplierName: 'Alert Coil Supplier',
    });
    const cutting = await agent.post('/api/cutting-lists').send({
      quotationRef: 'QT-2026-005',
      customerID: 'CUS-001',
      productID: 'FG-101',
      productName: 'Longspan thin',
      dateISO: '2026-03-29',
      machineName: 'M1',
      operatorName: 'QA',
      lines: [{ sheets: 1, lengthM: 5 }],
    });
    const job = await agent.post('/api/production-jobs').send({
      cuttingListId: cutting.body.id,
      productID: 'FG-101',
      productName: 'Longspan thin',
      plannedMeters: 5,
      plannedSheets: 1,
      status: 'Planned',
    });
    const jobId = job.body.jobID;
    await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/allocations`).send({
      allocations: [{ coilNo: 'CL-API-ALERT', openingWeightKg: 5000 }],
    });
    await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/start`).send({ startedAtISO: '2026-03-29' });

    const prev = await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/conversion-preview`).send({
      allocations: [{ coilNo: 'CL-API-ALERT', closingWeightKg: 0, metersProduced: 50 }],
    });
    expect(prev.status).toBe(200);
    expect(prev.body.managerReviewRequired).toBe(true);
    expect(['High', 'Low']).toContain(prev.body.aggregatedAlertState);
    expect(prev.body.rows[0].managerReviewRequired).toBe(true);
  });

  it('POST allocations with append adds a coil while job is running', async () => {
    const sup = await agent.post('/api/suppliers').send({ name: 'Append Test Sup', city: 'Test' });
    expect(sup.status).toBe(201);
    const mkGrn = async (coilNo, lineKey) => {
      const po = await agent.post('/api/purchase-orders').send({
        supplierID: sup.body.supplierID,
        supplierName: 'Append Test Sup',
        orderDateISO: '2026-04-01',
        expectedDeliveryISO: '',
        status: 'Approved',
        lines: [
          {
            lineKey,
            productID: 'COIL-ALU',
            productName: 'Aluminium coil (kg)',
            color: 'IV',
            gauge: '0.24',
            metersOffered: 2000,
            conversionKgPerM: 5000 / 2000,
            qtyOrdered: 5000,
            unitPricePerKgNgn: 100,
            unitPriceNgn: 100,
            qtyReceived: 0,
          },
        ],
      });
      expect(po.status).toBe(201);
      await agent.post(`/api/purchase-orders/${encodeURIComponent(po.body.poID)}/grn`).send({
        entries: [
          {
            lineKey,
            productID: 'COIL-ALU',
            qtyReceived: 5000,
            weightKg: 5000,
            coilNo,
            location: 'Bay',
            gaugeLabel: '0.24mm',
            materialTypeName: 'Aluminium',
            supplierExpectedMeters: 2000,
            supplierConversionKgPerM: 5000 / 2000,
          },
        ],
        supplierID: sup.body.supplierID,
        supplierName: 'Append Test Sup',
      });
    };
    await mkGrn('CL-APPEND-A', 'L-AP-A');
    await mkGrn('CL-APPEND-B', 'L-AP-B');
    const cutting = await agent.post('/api/cutting-lists').send({
      quotationRef: 'QT-2026-005',
      customerID: 'CUS-001',
      productID: 'FG-101',
      productName: 'Longspan thin',
      dateISO: '2026-04-01',
      machineName: 'M1',
      operatorName: 'QA',
      lines: [{ sheets: 1, lengthM: 5 }],
    });
    const job = await agent.post('/api/production-jobs').send({
      cuttingListId: cutting.body.id,
      productID: 'FG-101',
      productName: 'Longspan thin',
      plannedMeters: 5,
      plannedSheets: 1,
      status: 'Planned',
    });
    const jobId = job.body.jobID;
    await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/allocations`).send({
      allocations: [{ coilNo: 'CL-APPEND-A', openingWeightKg: 2000 }],
    });
    await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/start`).send({ startedAtISO: '2026-04-01' });
    const app = await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/allocations`).send({
      append: true,
      allocations: [{ coilNo: 'CL-APPEND-B', openingWeightKg: 1500 }],
    });
    expect(app.status).toBe(200);
    expect(app.body.ok).toBe(true);
    const boot = await agent.get('/api/bootstrap');
    const coils = boot.body.productionJobCoils.filter((c) => c.jobID === jobId);
    expect(coils.length).toBe(2);
  });

  it('POST coil-run-log corrects opening kg and coil identity while job is running', async () => {
    const sup = await agent.post('/api/suppliers').send({ name: 'RunLog Correct Sup', city: 'Test' });
    expect(sup.status).toBe(201);
    const mkGrn = async (coilNo, lineKey) => {
      const po = await agent.post('/api/purchase-orders').send({
        supplierID: sup.body.supplierID,
        supplierName: 'RunLog Correct Sup',
        orderDateISO: '2026-04-02',
        expectedDeliveryISO: '',
        status: 'Approved',
        lines: [
          {
            lineKey,
            productID: 'COIL-ALU',
            productName: 'Aluminium coil (kg)',
            color: 'IV',
            gauge: '0.24',
            metersOffered: 2000,
            conversionKgPerM: 5000 / 2000,
            qtyOrdered: 5000,
            unitPricePerKgNgn: 100,
            unitPriceNgn: 100,
            qtyReceived: 0,
          },
        ],
      });
      expect(po.status).toBe(201);
      await agent.post(`/api/purchase-orders/${encodeURIComponent(po.body.poID)}/grn`).send({
        entries: [
          {
            lineKey,
            productID: 'COIL-ALU',
            qtyReceived: 5000,
            weightKg: 5000,
            coilNo,
            location: 'Bay',
            gaugeLabel: '0.24mm',
            materialTypeName: 'Aluminium',
            supplierExpectedMeters: 2000,
            supplierConversionKgPerM: 5000 / 2000,
          },
        ],
        supplierID: sup.body.supplierID,
        supplierName: 'RunLog Correct Sup',
      });
    };
    await mkGrn('CL-RLOG-C1', 'L-RL-C1');
    await mkGrn('CL-RLOG-C2', 'L-RL-C2');
    const cutting = await agent.post('/api/cutting-lists').send({
      quotationRef: 'QT-2026-005',
      customerID: 'CUS-001',
      productID: 'FG-101',
      productName: 'Longspan thin',
      dateISO: '2026-04-02',
      machineName: 'M1',
      operatorName: 'QA',
      lines: [{ sheets: 1, lengthM: 5 }],
    });
    const job = await agent.post('/api/production-jobs').send({
      cuttingListId: cutting.body.id,
      productID: 'FG-101',
      productName: 'Longspan thin',
      plannedMeters: 5,
      plannedSheets: 1,
      status: 'Planned',
    });
    const jobId = job.body.jobID;
    await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/allocations`).send({
      allocations: [{ coilNo: 'CL-RLOG-C1', openingWeightKg: 2000 }],
    });
    await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/start`).send({ startedAtISO: '2026-04-02' });
    const listAlloc = await agent.get(`/api/production-jobs/${encodeURIComponent(jobId)}/coil-allocations`);
    expect(listAlloc.status).toBe(200);
    const allocId = listAlloc.body.allocations[0].id;
    const r1 = await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/coil-run-log`).send({
      readings: [
        {
          allocationId: allocId,
          coilNo: 'CL-RLOG-C1',
          openingWeightKg: 1500,
          closingWeightKg: 0,
          metersProduced: 0,
          note: '',
        },
      ],
    });
    expect(r1.status).toBe(200);
    expect(r1.body.ok).toBe(true);
    expect(r1.body.allocations[0].openingWeightKg).toBe(1500);
    const r2 = await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/coil-run-log`).send({
      readings: [
        {
          allocationId: allocId,
          coilNo: 'CL-RLOG-C2',
          openingWeightKg: 1200,
          closingWeightKg: 0,
          metersProduced: 0,
          note: 'wrong coil typed',
        },
      ],
    });
    expect(r2.status).toBe(200);
    expect(r2.body.ok).toBe(true);
    expect(r2.body.allocations[0].coilNo).toBe('CL-RLOG-C2');
    expect(r2.body.allocations[0].openingWeightKg).toBe(1200);
  });

  it('PATCH manager-review-signoff records remark and clears open review flag', async () => {
    const sup = await agent.post('/api/suppliers').send({ name: 'Signoff Supplier', city: 'Kano' });
    expect(sup.status).toBe(201);
    const po = await agent.post('/api/purchase-orders').send({
      supplierID: sup.body.supplierID,
      supplierName: 'Signoff Supplier',
      orderDateISO: '2026-03-29',
      expectedDeliveryISO: '',
      status: 'Approved',
      lines: [
        {
          lineKey: 'L-SO',
          productID: 'COIL-ALU',
          productName: 'Aluminium coil (kg)',
          color: 'IV',
          gauge: '0.24',
          metersOffered: 2650,
          conversionKgPerM: 6000 / 2650,
          qtyOrdered: 6000,
          unitPricePerKgNgn: 100,
          unitPriceNgn: 100,
          qtyReceived: 0,
        },
      ],
    });
    expect(po.status).toBe(201);
    await agent.post(`/api/purchase-orders/${encodeURIComponent(po.body.poID)}/grn`).send({
      entries: [
        {
          lineKey: 'L-SO',
          productID: 'COIL-ALU',
          qtyReceived: 6000,
          weightKg: 6000,
          coilNo: 'CL-API-SIGNOFF',
          location: 'Bay',
          gaugeLabel: '0.24mm',
          materialTypeName: 'Aluminium',
          supplierExpectedMeters: 2650,
          supplierConversionKgPerM: 6000 / 2650,
        },
      ],
      supplierID: sup.body.supplierID,
      supplierName: 'Signoff Supplier',
    });
    const cutting = await agent.post('/api/cutting-lists').send({
      quotationRef: 'QT-2026-005',
      customerID: 'CUS-001',
      productID: 'FG-101',
      productName: 'Longspan thin',
      dateISO: '2026-03-29',
      machineName: 'M1',
      operatorName: 'QA',
      lines: [{ sheets: 1, lengthM: 5 }],
    });
    const job = await agent.post('/api/production-jobs').send({
      cuttingListId: cutting.body.id,
      productID: 'FG-101',
      productName: 'Longspan thin',
      plannedMeters: 5,
      plannedSheets: 1,
      status: 'Planned',
    });
    const jobId = job.body.jobID;
    await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/allocations`).send({
      allocations: [{ coilNo: 'CL-API-SIGNOFF', openingWeightKg: 5000 }],
    });
    await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/start`).send({ startedAtISO: '2026-03-29' });
    const done = await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/complete`).send({
      completedAtISO: '2026-03-29',
      allocations: [{ coilNo: 'CL-API-SIGNOFF', closingWeightKg: 0, metersProduced: 50, finishCoil: true }],
    });
    expect(done.status).toBe(200);
    expect(done.body.managerReviewRequired).toBe(true);

    const so = await agent.patch(`/api/production-jobs/${encodeURIComponent(jobId)}/manager-review-signoff`).send({
      remark: 'Reviewed variance — acceptable scrap margin.',
    });
    expect(so.status).toBe(200);
    expect(so.body.ok).toBe(true);
    expect(so.body.managerReviewRemark).toContain('scrap');

    const boot = await agent.get('/api/bootstrap');
    const pj = boot.body.productionJobs.find((j) => j.jobID === jobId);
    expect(pj).toBeDefined();
    expect(pj.managerReviewRequired).toBe(false);
    expect(pj.managerReviewSignedAtISO).toBeTruthy();
    expect(pj.managerReviewRemark).toContain('scrap');

    const dup = await agent.patch(`/api/production-jobs/${encodeURIComponent(jobId)}/manager-review-signoff`).send({
      remark: 'Second attempt',
    });
    expect(dup.status).toBe(400);

    const staff = request.agent(app);
    await loginAs(staff, 'sales.staff', 'Sales@123');
    const denied = await staff
      .patch(`/api/production-jobs/${encodeURIComponent(jobId)}/manager-review-signoff`)
      .send({ remark: 'Should not work' });
    expect(denied.status).toBe(403);
  });

  it('POST return-to-planned (running→planned) and FG completion-adjustments (audit + stock)', async () => {
    const sup = await agent.post('/api/suppliers').send({ name: 'Adj Supplier', city: 'Kano' });
    expect(sup.status).toBe(201);
    const po = await agent.post('/api/purchase-orders').send({
      supplierID: sup.body.supplierID,
      supplierName: 'Adj Supplier',
      orderDateISO: '2026-03-30',
      expectedDeliveryISO: '',
      status: 'Approved',
      lines: [
        {
          lineKey: 'L-ADJ',
          productID: 'COIL-ALU',
          productName: 'Aluminium coil (kg)',
          color: 'IV',
          gauge: '0.24',
          metersOffered: 2650,
          conversionKgPerM: 6000 / 2650,
          qtyOrdered: 6000,
          unitPricePerKgNgn: 100,
          unitPriceNgn: 100,
          qtyReceived: 0,
        },
      ],
    });
    expect(po.status).toBe(201);
    await agent.post(`/api/purchase-orders/${encodeURIComponent(po.body.poID)}/grn`).send({
      entries: [
        {
          lineKey: 'L-ADJ',
          productID: 'COIL-ALU',
          qtyReceived: 6000,
          weightKg: 6000,
          coilNo: 'CL-API-ADJ',
          location: 'Bay',
          gaugeLabel: '0.24mm',
          materialTypeName: 'Aluminium',
          supplierExpectedMeters: 2650,
          supplierConversionKgPerM: 6000 / 2650,
        },
      ],
      supplierID: sup.body.supplierID,
      supplierName: 'Adj Supplier',
    });
    const cutting = await agent.post('/api/cutting-lists').send({
      quotationRef: 'QT-2026-005',
      customerID: 'CUS-001',
      productID: 'FG-101',
      productName: 'Longspan thin',
      dateISO: '2026-03-30',
      machineName: 'M1',
      operatorName: 'QA',
      lines: [{ sheets: 1, lengthM: 10 }],
    });
    const job = await agent.post('/api/production-jobs').send({
      cuttingListId: cutting.body.id,
      productID: 'FG-101',
      productName: 'Longspan thin',
      plannedMeters: 10,
      plannedSheets: 1,
      status: 'Planned',
    });
    const jobId = job.body.jobID;
    await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/allocations`).send({
      allocations: [{ coilNo: 'CL-API-ADJ', openingWeightKg: 4000 }],
    });
    await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/start`).send({ startedAtISO: '2026-03-30' });
    const bad = await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/return-to-planned`).send({
      reason: 'short',
    });
    expect(bad.status).toBe(400);
    const back = await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/return-to-planned`).send({
      reason: 'Wrong coil picked — return to swap allocation before run.',
    });
    expect(back.status).toBe(200);
    expect(back.body.ok).toBe(true);
    const bootMid = await agent.get('/api/bootstrap');
    const pj = bootMid.body.productionJobs.find((j) => j.jobID === jobId);
    expect(pj.status).toBe('Planned');

    await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/start`).send({ startedAtISO: '2026-03-30' });
    const done = await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/complete`).send({
      completedAtISO: '2026-03-30',
      allocations: [{ coilNo: 'CL-API-ADJ', closingWeightKg: 0, metersProduced: 10, finishCoil: true }],
    });
    expect(done.status).toBe(200);
    const fgBefore = await agent.get('/api/bootstrap');
    const fgProdBefore = fgBefore.body.products.find((p) => p.productID === 'FG-101');
    const stockBefore = Number(fgProdBefore?.stockLevel ?? 0);
    const adj = await agent.post(`/api/production-jobs/${encodeURIComponent(jobId)}/completion-adjustments`).send({
      deltaFinishedGoodsM: -1.25,
      note: 'Physical recount short — roll end scrap not entered at completion.',
    });
    expect(adj.status).toBe(200);
    expect(adj.body.ok).toBe(true);
    const fgAfter = await agent.get('/api/bootstrap');
    const pj2 = fgAfter.body.productionJobs.find((j) => j.jobID === jobId);
    expect(pj2.fgAdjustmentMetersTotal).toBeCloseTo(-1.25, 5);
    expect(pj2.effectiveOutputMeters).toBeCloseTo(8.75, 5);
    const fgProdAfter = fgAfter.body.products.find((p) => p.productID === 'FG-101');
    const stockAfter = Number(fgProdAfter?.stockLevel ?? 0);
    expect(stockAfter).toBeCloseTo(stockBefore - 1.25, 5);
  });

  it('GET /api/refunds/eligible-quotations, intelligence — permissions and response shape', async () => {
    const salesStaff = request.agent(app);
    await loginAs(salesStaff, 'sales.staff', 'Sales@123');
    const elig = await salesStaff.get('/api/refunds/eligible-quotations');
    expect(elig.status).toBe(200);
    expect(elig.body.ok).toBe(true);
    expect(Array.isArray(elig.body.quotations)).toBe(true);

    const noRef = await salesStaff.get('/api/refunds/intelligence');
    expect(noRef.status).toBe(400);
    expect(noRef.body.ok).toBe(false);

    const intel = await salesStaff.get('/api/refunds/intelligence?quotationRef=QT-2026-001');
    expect(intel.status).toBe(200);
    expect(intel.body.ok).toBe(true);
    expect(Array.isArray(intel.body.receipts)).toBe(true);
    expect(Array.isArray(intel.body.cuttingLists)).toBe(true);
    expect(intel.body.summary).toBeDefined();
    expect(typeof intel.body.summary.producedMeters).toBe('number');
    expect(Array.isArray(intel.body.summary.accessoriesSummary?.lines)).toBe(true);
    expect(typeof intel.body.summary.overpayAdvanceNgn).toBe('number');
    expect(typeof intel.body.summary.bookedOnQuotationNgn).toBe('number');
    expect(typeof intel.body.summary.quotationCashInNgn).toBe('number');
    expect(typeof intel.body.summary.receiptAllocatedSumNgn).toBe('number');
    expect(typeof intel.body.summary.advanceAppliedNgn).toBe('number');

    const staff = request.agent(app);
    await loginAs(staff, 'sales.staff', 'Sales@123');
    const denied = await staff.get('/api/refunds/eligible-quotations');
    expect(denied.status).toBe(403);
  });

  it('GET /api/reports/production-transaction returns row array', async () => {
    const admin = request.agent(app);
    await loginAs(admin);
    const res = await admin.get(
      '/api/reports/production-transaction?startDate=2026-01-01&endDate=2026-12-31'
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.rows)).toBe(true);
  });

  it('GET /api/reports/receipts-register and sales-bridge return row arrays', async () => {
    const admin = request.agent(app);
    await loginAs(admin);
    const rr = await admin.get('/api/reports/receipts-register?startDate=2026-01-01&endDate=2026-12-31');
    expect(rr.status).toBe(200);
    expect(rr.body.ok).toBe(true);
    expect(Array.isArray(rr.body.rows)).toBe(true);
    const sb = await admin.get(
      '/api/reports/sales-bridge?startDate=2026-01-01&endDate=2026-12-31&asAtDate=2026-12-31'
    );
    expect(sb.status).toBe(200);
    expect(sb.body.ok).toBe(true);
    expect(Array.isArray(sb.body.rows)).toBe(true);
    const rev = await admin.get('/api/reports/revenue-production?startDate=2026-01-01&endDate=2026-12-31');
    expect(rev.status).toBe(200);
    expect(rev.body.ok).toBe(true);
    expect(Array.isArray(rev.body.rows)).toBe(true);
    const ar = await admin.get('/api/reports/ar-as-at?asAtDate=2026-12-31');
    expect(ar.status).toBe(200);
    expect(ar.body.ok).toBe(true);
    expect(Array.isArray(ar.body.rows)).toBe(true);
  });

  it('GET /api/reports/ar-as-at allows finance_manager (management reports)', async () => {
    const fin = request.agent(app);
    await loginAs(fin, 'finance.manager', 'Finance@123');
    const ar = await fin.get('/api/reports/ar-as-at?asAtDate=2026-12-31');
    expect(ar.status).toBe(200);
    expect(ar.body.ok).toBe(true);
    expect(Array.isArray(ar.body.rows)).toBe(true);
  });

  it('GET /api/finance/reconciliation-pack returns management draft envelope', async () => {
    const fin = request.agent(app);
    await loginAs(fin, 'finance.manager', 'Finance@123');
    const bad = await fin.get('/api/finance/reconciliation-pack?period=bad');
    expect(bad.status).toBe(400);
    expect(bad.body.ok).toBe(false);
    expect(bad.body.error).toMatch(/Invalid period/i);

    const res = await fin.get('/api/finance/reconciliation-pack?period=2026-05');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.status).toBe('management_draft');
    expect(res.body.disclaimer).toMatch(/not statutory/i);
    expect(res.body.cashConfirmationBasis).toMatch(/Receipt confirmation/i);
    expect(res.body.pack?.ok).toBe(true);
    expect(res.body.cashFlowSummary?.ok).toBe(true);
    expect(res.body.departmentOwnership?.accounting).toMatch(/Head of Accounts/i);
  });

  it('stock register API: GET, print snapshot, workflow, capture closing', async () => {
    const admin = request.agent(app);
    await loginAs(admin);
    const periodEnd = '2026-04-30';

    const getRes = await admin.get(`/api/stock-register?periodEnd=${periodEnd}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.ok).toBe(true);
    expect(getRes.body.register).toBeTruthy();
    expect(getRes.body.register.periodKey).toBe('2026-04');
    expect(getRes.body.register.coilSections).toBeTruthy();
    expect(getRes.body.register.summary).toBeTruthy();

    const printRes = await admin.post('/api/stock-register/print-snapshot').send({ periodEnd });
    expect(printRes.status).toBe(200);
    expect(printRes.body.ok).toBe(true);
    expect(printRes.body.workflow?.status).toBe('printed');

    const storeRes = await admin.post('/api/stock-register/workflow').send({
      action: 'forward_to_manager',
      periodKey: '2026-04',
      countNotes: 'API test count OK',
      storeChecklist: {
        coilsCounted: true,
        finishedVerified: true,
        stoneCounted: true,
        accessoriesCounted: true,
        inTransitReviewed: true,
      },
    });
    expect(storeRes.status).toBe(200);
    expect(storeRes.body.ok).toBe(true);
    expect(storeRes.body.workflow?.status).toBe('store_confirmed');

    const clearance = { lines: {} };
    const reg = getRes.body.register;
    for (const fam of ['aluminium', 'aluzinc']) {
      for (const g of reg.coilSections?.[fam]?.groups || []) {
        for (const r of g.rows || []) {
          const key = r.finishedInPeriod ? `finished:${r.coilNo}` : `coil:${r.coilNo}`;
          clearance.lines[key] = r.finishedInPeriod
            ? { status: 'cleared', finishedConfirm: 'confirmed' }
            : { status: 'cleared' };
        }
      }
    }
    await admin.post('/api/stock-register/line-clearance').send({ periodKey: '2026-04', lineClearance: clearance });

    const bmRes = await admin.post('/api/stock-register/workflow').send({
      action: 'bm_approve',
      periodKey: '2026-04',
      lineClearance: clearance,
    });
    expect(bmRes.status).toBe(200);
    expect(bmRes.body.workflow?.status).toBe('bm_approved');

    const procRes = await admin.post('/api/stock-register/workflow').send({
      action: 'procurement_cost',
      periodKey: '2026-04',
      pricing: {
        aluminiumUnitCostNgnPerKg: 1200,
        aluzincUnitCostNgnPerKg: 900,
        stoneUnitPriceNgnPerM: 500,
        accessoryUnitPriceNgn: 50,
      },
    });
    expect(procRes.status).toBe(200);
    expect(procRes.body.workflow?.status).toBe('procurement_costed');

    const mdRes = await admin.post('/api/stock-register/workflow').send({
      action: 'md_approve',
      periodKey: '2026-04',
    });
    expect(mdRes.status).toBe(200);
    expect(mdRes.body.workflow?.status).toBe('md_approved');

    const capRes = await admin.post('/api/stock-register/capture-closing').send({ periodEnd });
    expect(capRes.status).toBe(200);
    expect(capRes.body.ok).toBe(true);
    expect(capRes.body.workflow?.status).toBe('locked');

    const stockForm = await admin.patch('/api/coil-lots/1967/stock-form').send({ stockForm: 'roll' });
    if (stockForm.status === 200) {
      expect(stockForm.body.ok).toBe(true);
      expect(stockForm.body.stockForm).toBe('roll');
    }
  });

  it('POST /api/coil-lots/import upserts spreadsheet rows', async () => {
    const admin = request.agent(app);
    await loginAs(admin);
    const coilNo = `API-XLS-${Date.now()}`;
    const res = await admin.post('/api/coil-lots/import').send({
      insertOnly: true,
      rows: [
        {
          coilNo,
          productID: 'COIL-ALU',
          currentKg: 100,
          colour: 'White',
          gaugeLabel: '0.45',
        },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.imported).toBe(1);
  });

  it('POST /api/refunds/preview returns suggested lines from inputs', async () => {
    const q = await agent.post('/api/quotations').send({
      customerID: 'CUS-001',
      projectName: `Refund preview ${Date.now()}`,
      dateISO: '2026-03-29',
      lines: {
        products: [{ name: 'Refund preview item', qty: '1', unitPrice: '100000' }],
        accessories: [],
        services: [],
      },
    });
    expect(q.status).toBe(201);
    const quotationRef = q.body.quotation?.quotationID || q.body.quotation?.id || q.body.quotationID || q.body.id;
    expect(String(quotationRef || '')).toBeTruthy();
    const prev = await agent.post('/api/refunds/preview').send({
      customerID: 'CUS-001',
      quotationRef,
      manualAdjustmentNgn: 25_000,
    });
    expect(prev.status).toBe(200);
    expect(Number(prev.body.preview.suggestedAmountNgn || 0)).toBeGreaterThanOrEqual(25_000);
  });

  it('approved refunds support staged split payout until fully settled', async () => {
    const boot = await agent.get('/api/bootstrap');
    const [cashAccount, bankAccount] = boot.body.treasuryAccounts.slice(0, 2);
    const salesStaff = request.agent(app);
    await loginAs(salesStaff, 'sales.staff', 'Sales@123');
    const created = await salesStaff.post('/api/refunds').send({
      ...REFUND_TEST_PAYEE,
      customerID: 'CUS-002',
      customer: 'Test Customer',
      quotationRef: 'QT-2026-002',
      reasonCategory: 'Adjustment',
      reason: 'Staged payout test',
      amountNgn: 500_000,
      calculationLines: [
        { label: 'Line A', amountNgn: 200_000 },
        { label: 'Line B', amountNgn: 300_000 },
      ],
    });
    expect(created.status).toBe(201);

    const managerAgent = request.agent(app);
    await loginAs(managerAgent, 'sales.manager', 'Sales@123');
    await managerAgent.post(`/api/refunds/${encodeURIComponent(created.body.refundID)}/decision`).send({
      status: 'Approved',
      approvalDate: '2026-03-29',
      managerComments: 'Approved for staged pay',
      approvedAmountNgn: 500_000,
    });

    const financeAgent = request.agent(app);
    await loginAs(financeAgent, 'finance.manager', 'Finance@123');
    const pay1 = await financeAgent.post(`/api/refunds/${encodeURIComponent(created.body.refundID)}/pay`).send({
      paymentLines: [
        { treasuryAccountId: cashAccount.id, amountNgn: 180_000, reference: 'RF-STG-1' },
        { treasuryAccountId: bankAccount.id, amountNgn: 120_000, reference: 'RF-STG-2' },
      ],
    });
    expect(pay1.status).toBe(201);
    expect(pay1.body.fullyPaid).toBe(false);
    expect(pay1.body.paidAmountNgn).toBe(300_000);

    const mid = await financeAgent.get('/api/bootstrap');
    const rowMid = mid.body.refunds.find((r) => r.refundID === created.body.refundID);
    expect(rowMid.status).toBe('Approved');
    expect(rowMid.paidAmountNgn).toBe(300_000);

    const pay2 = await financeAgent.post(`/api/refunds/${encodeURIComponent(created.body.refundID)}/pay`).send({
      paymentLines: [{ treasuryAccountId: cashAccount.id, amountNgn: 200_000, reference: 'RF-STG-3' }],
    });
    expect(pay2.status).toBe(201);
    expect(pay2.body.fullyPaid).toBe(true);

    const end = await financeAgent.get('/api/bootstrap');
    const rowEnd = end.body.refunds.find((r) => r.refundID === created.body.refundID);
    expect(rowEnd.status).toBe('Paid');
    expect(rowEnd.paidAmountNgn).toBe(500_000);
  });

  it('GET /api/setup and master-data POST/PATCH/DELETE round-trip', async () => {
    const list = await agent.get('/api/setup');
    expect(list.status).toBe(200);
    const beforeCount = list.body.masterData.colours.length;
    const created = await agent.post('/api/setup/colours').send({
      name: 'API Test Colour',
      abbreviation: 'ATC',
      sortOrder: 99,
      active: true,
    });
    expect(created.status).toBe(201);
    const newId = created.body.id;
    expect(newId).toBeTruthy();

    const afterCreate = await agent.get('/api/setup');
    expect(afterCreate.body.masterData.colours.length).toBe(beforeCount + 1);

    const patched = await agent.patch(`/api/setup/colours/${encodeURIComponent(newId)}`).send({
      name: 'API Test Colour Renamed',
      abbreviation: 'ATR',
      sortOrder: 100,
      active: true,
    });
    expect(patched.status).toBe(200);

    const del = await agent.delete(`/api/setup/colours/${encodeURIComponent(newId)}`);
    expect(del.status).toBe(200);

    const afterDel = await agent.get('/api/setup');
    expect(afterDel.body.masterData.colours.length).toBe(beforeCount);
  });

  it('GET /api/branches/strict-audit reports branch integrity', async () => {
    const res = await agent.get('/api/branches/strict-audit');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(typeof res.body.strictBranchIsolationOk).toBe('boolean');
    expect(Array.isArray(res.body.knownBranches)).toBe(true);
    expect(Array.isArray(res.body.tables)).toBe(true);
    expect(res.body.tables.some((t) => t.table === 'customers')).toBe(true);
    expect(typeof res.body.totals?.missingBranchIdRows).toBe('number');
    expect(typeof res.body.totals?.invalidBranchIdRows).toBe('number');
  });

  it('PATCH /api/branches/:branchId/cutting-threshold updates min paid fraction', async () => {
    const boot = await agent.get('/api/bootstrap');
    expect(boot.status).toBe(200);
    const bid = boot.body.workspaceBranches?.[0]?.id;
    expect(bid).toBeTruthy();
    const res = await agent
      .patch(`/api/branches/${encodeURIComponent(bid)}/cutting-threshold`)
      .send({ cuttingListMinPaidFraction: 0.85 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.cuttingListMinPaidFraction).toBeCloseTo(0.85, 5);
    const boot2 = await agent.get('/api/bootstrap');
    const br = boot2.body.workspaceBranches?.find((b) => b.id === bid);
    expect(br?.cuttingListMinPaidFraction).toBeCloseTo(0.85, 5);
    const restore = await agent
      .patch(`/api/branches/${encodeURIComponent(bid)}/cutting-threshold`)
      .send({ cuttingListMinPaidFraction: 0.7 });
    expect(restore.status).toBe(200);
  });








  it('GET /api/pricing/policy (auth); md PATCH; customer book; pricing-violations for under-floor quote', async () => {
    const pol = await agent.get('/api/pricing/policy');
    expect(pol.status).toBe(200);
    expect(pol.body.ok).toBe(true);
    expect(pol.body.policy).toBeTruthy();

    const staff = request.agent(app);
    await loginAs(staff, 'sales.staff', 'Sales@123');
    expect((await staff.get('/api/pricing/policy')).status).toBe(403);
    expect((await staff.patch('/api/pricing/policy').send({ defaultTradingBandNgn: 99 })).status).toBe(403);

    const md = request.agent(app);
    await loginAs(md, 'md', 'Md@1234567890!');
    const patch = await md.patch('/api/pricing/policy').send({ defaultTradingBandNgn: 77 });
    expect(patch.status).toBe(200);
    expect(patch.body.ok).toBe(true);

    const ridgeOnly = await md.patch('/api/pricing/policy').send({
      ridgeAddOns: [{ girthMm: 300, materialFamily: 'alu', addOnNgn: 100, listAddOnNgn: 120 }],
    });
    expect(ridgeOnly.status).toBe(200);
    expect(ridgeOnly.body.ok).toBe(true);
    expect(ridgeOnly.body.policy.defaultTradingBandNgn).toBe(77);
    expect(Array.isArray(ridgeOnly.body.ridgeAddOns)).toBe(true);
    const r300 = ridgeOnly.body.ridgeAddOns.find((x) => Number(x.girthMm) === 300);
    expect(r300).toBeTruthy();
    expect(r300.addOnNgn).toBe(100);
    expect(r300.listAddOnNgn).toBe(120);

    const book = await agent.get('/api/pricing/customer-price-book.html');
    expect(book.status).toBe(200);
    expect(String(book.headers['content-type'] || '')).toMatch(/html/i);
    expect(book.text.length).toBeGreaterThan(100);

    const pl = await agent.post('/api/pricing/price-list').send({
      gaugeKey: '0.55mm',
      designKey: 'milano',
      unitPricePerMeterNgn: 4000,
      effectiveFromIso: '2026-01-01',
    });
    expect(pl.status).toBe(201);
    expect(pl.body.ok).toBe(true);

    const q = await agent.post('/api/quotations').send({
      customerID: 'CUS-001',
      projectName: 'Pricing policy API test',
      dateISO: '2026-03-29',
      lines: {
        materialGauge: '0.55mm',
        materialDesign: 'milano',
        products: [{ name: 'Roof', qty: '10', unitPrice: '500' }],
        accessories: [],
        services: [],
      },
    });
    expect(q.status).toBe(201);
    const qid = q.body.quotationId;
    const v = await staff.get(`/api/quotations/${encodeURIComponent(qid)}/pricing-violations`);
    expect(v.status).toBe(200);
    expect(v.body.ok).toBe(true);
    expect(Array.isArray(v.body.violations)).toBe(true);
    expect(v.body.violations.length).toBeGreaterThan(0);
    expect(v.body.violations.some((x) => x.code === 'below_floor' || x.code === 'below_trading_band')).toBe(
      true
    );
  });

  it('GET /api/gl/journals, journal lines, and activity return ok for admin', async () => {
    const signedAgent = request.agent(app);
    await loginAs(signedAgent);
    const j = await signedAgent.get('/api/gl/journals?startDate=2024-01-01&endDate=2024-12-31');
    expect(j.status).toBe(200);
    expect(j.body.ok).toBe(true);
    expect(Array.isArray(j.body.journals)).toBe(true);

    const a = await signedAgent.get('/api/gl/activity?startDate=2024-01-01&endDate=2024-12-31');
    expect(a.status).toBe(200);
    expect(a.body.ok).toBe(true);
    expect(Array.isArray(a.body.lines)).toBe(true);

    if (j.body.journals?.length) {
      const jid = j.body.journals[0].journalId;
      const lines = await signedAgent.get(`/api/gl/journals/${encodeURIComponent(jid)}/lines`);
      expect(lines.status).toBe(200);
      expect(lines.body.ok).toBe(true);
      expect(Array.isArray(lines.body.lines)).toBe(true);
    }
  });


  it('POST /api/inventory/stone-receipt, accessory-receipt, ensure-stone-product; GET /api/pricing/resolve', async () => {
    const stone = await agent.post('/api/inventory/stone-receipt').send({
      designLabel: 'Milano',
      colourLabel: 'Black',
      gaugeLabel: '0.40mm',
      metresReceived: 12,
    });
    expect(stone.status).toBe(200);
    expect(stone.body.ok).toBe(true);
    expect(String(stone.body.productId || '')).toMatch(/^STONE-/);

    const acc = await agent.post('/api/inventory/accessory-receipt').send({
      productID: 'ACC-TAPPING-SCREW-PCS',
      qtyReceived: 100,
    });
    expect(acc.status).toBe(200);
    expect(acc.body.ok).toBe(true);

    const pr = await agent.get('/api/pricing/resolve').query({
      quoteItemId: 'SQI-001',
      gaugeId: 'GAU-003',
      colourId: 'COL-001',
      materialTypeId: 'MAT-001',
      profileId: 'PROF-001',
    });
    expect(pr.status).toBe(200);
    expect(pr.body.ok).toBe(true);
    expect(Number(pr.body.result?.unitPriceNgn || 0)).toBeGreaterThan(0);

    const ens = await agent.post('/api/inventory/ensure-stone-product').send({
      designLabel: 'Bond',
      colourLabel: 'Red',
      gaugeLabel: '0.45mm',
    });
    expect(ens.status).toBe(200);
    expect(ens.body.ok).toBe(true);
    expect(String(ens.body.productId || '')).toMatch(/^STONE-/);

    const csvExport = await agent.get('/api/pricing/price-list/export.csv');
    expect(csvExport.status).toBe(200);
    expect(String(csvExport.headers['content-type'] || '')).toMatch(/csv/i);
    expect(csvExport.text).toMatch(/gauge_key/);

    const mps = await agent.get('/api/pricing/material-sheet').query({ materialKey: 'alu', branchId: 'BR-KD' });
    expect(mps.status).toBe(200);
    expect(mps.body.ok).toBe(true);
    expect(Array.isArray(mps.body.gauges)).toBe(true);
    expect(mps.body.gauges.length).toBeGreaterThan(0);
    expect(mps.body).toHaveProperty('purchaseAvgConversionByGauge');
    expect(mps.body).toHaveProperty('gaugeHistoryAvgConversionByGauge');
    expect(typeof mps.body.purchaseAvgConversionByGauge).toBe('object');
    expect(typeof mps.body.gaugeHistoryAvgConversionByGauge).toBe('object');
    expect(mps.body.resolvedByGauge?.[mps.body.gauges[0]]).toHaveProperty('usedSuggested');

    const mwAll = await agent.get('/api/pricing/material-workbook-all.html').query({ branchId: 'BR-KD' });
    expect(mwAll.status).toBe(200);
    expect(String(mwAll.headers['content-type'] || '')).toMatch(/html/i);
    expect(mwAll.text).toMatch(/Aluminium/i);
    expect(mwAll.text).toMatch(/Stone-coated/i);
    expect(mwAll.text).toMatch(/Accessories/i);

    const mpsSave = await agent.post('/api/pricing/material-sheet/rows').send({
      materialKey: 'alu',
      gaugeMm: '0.45',
      branchId: 'BR-KD',
      designKey: '',
      conversionReferenceKgPerM: 1.5,
      conversionHistoryKgPerM: 1.52,
      costPerKgNgn: 800,
      conversionUsedKgPerM: 1.51,
      overheadNgnPerM: 100,
      profitNgnPerM: 50,
      minimumPricePerMeterNgn: 5000,
      commissionNgnPerM: 200,
      syncMinimumToPriceList: true,
      syncDesignKey: 'longspan',
    });
    expect(mpsSave.status).toBe(200);
    expect(mpsSave.body.ok).toBe(true);

    const mpsReload = await agent
      .get('/api/pricing/material-sheet')
      .query({ materialKey: 'alu', branchId: 'BR-KD' });
    expect(mpsReload.status).toBe(200);
    const blankDesignRow = (mpsReload.body.rows || []).find(
      (r) => String(r.gaugeMm) === '0.45' && !String(r.designKey || '').trim()
    );
    expect(blankDesignRow?.syncMinimumToPriceList).toBe(true);
    expect(String(blankDesignRow?.syncDesignKey || '')).toBe('longspan');

    const mpsEv = await agent.get('/api/pricing/material-sheet/events').query({ materialKey: 'alu' });
    expect(mpsEv.status).toBe(200);
    expect(mpsEv.body.ok).toBe(true);
    expect(Array.isArray(mpsEv.body.events)).toBe(true);
    expect(mpsEv.body.events.length).toBeGreaterThan(0);
  });

  it('Office Desk: summary, thread detail, convert to payment request', async () => {
    const sum = await agent.get('/api/office/summary');
    expect(sum.status).toBe(200);
    expect(sum.body.ok).toBe(true);
    expect(sum.body).toHaveProperty('unreadApprox');

    const create = await agent.post('/api/office/threads').send({
      subject: 'API test memo',
      body: 'Conversion body',
      kind: 'memo',
    });
    expect(create.status).toBe(201);
    expect(create.body.thread?.id).toBeTruthy();
    const tid = create.body.thread.id;

    const detail = await agent.get(`/api/office/threads/${encodeURIComponent(tid)}`);
    expect(detail.status).toBe(200);
    expect(detail.body.ok).toBe(true);
    expect(detail.body.thread?.id).toBe(tid);

    const conv = await agent.post(`/api/office/threads/${encodeURIComponent(tid)}/convert-payment-request`).send({
      requestDate: '2026-04-09',
      description: 'Office API test',
      requestReference: 'OFFICE-API',
      expenseCategory: 'Truck & mining',
      lineItems: [{ item: 'Test item', unit: 2, unitPriceNgn: 2500 }],
    });
    expect(conv.status).toBe(200);
    expect(conv.body.ok).toBe(true);
    expect(conv.body.requestID).toBeTruthy();

    const boot = await agent.get('/api/bootstrap');
    const pr = boot.body.paymentRequests.find((r) => r.requestID === conv.body.requestID);
    expect(pr).toBeTruthy();
  });

  it('GET /api/office/summary requires authentication', async () => {
    const res = await request(app).get('/api/office/summary');
    expect(res.status).toBe(401);
  });

  it('POST /api/office/ai/polish-memo returns 503 when AI is not configured', async () => {
    const res = await agent.post('/api/office/ai/polish-memo').send({ subject: 'Test', body: 'Hello' });
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
  });

  it('GET /api/office/filing returns filings array for signed-in user', async () => {
    const res = await agent.get('/api/office/filing');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.filings)).toBe(true);
  });

  it('POST /api/office/threads/:id/ai-file returns 503 when AI is not configured', async () => {
    const create = await agent.post('/api/office/threads').send({
      subject: 'Filing API test',
      body: 'Need fuel',
      kind: 'memo',
    });
    expect(create.status).toBe(201);
    const tid = create.body.thread.id;
    const res = await agent.post(`/api/office/threads/${encodeURIComponent(tid)}/ai-file`).send({});
    expect(res.status).toBe(503);
    expect(res.body.ok).toBe(false);
  });

  it('GET /api/admin/data-reset-presets returns 403 for non-admin', async () => {
    const salesAgent = request.agent(app);
    await loginAs(salesAgent, 'sales.staff', 'Sales@123');
    const res = await salesAgent.get('/api/admin/data-reset-presets');
    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);
  });

  it('GET /api/admin/data-reset-presets returns presets for admin', async () => {
    const res = await agent.get('/api/admin/data-reset-presets');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.presets)).toBe(true);
    expect(res.body.presets.length).toBeGreaterThan(0);
    expect(res.body.presets[0]).toHaveProperty('id');
    expect(res.body.presets[0]).toHaveProperty('label');
    expect(String(res.body.confirmPhrase || '')).toBeTruthy();
  });

  it('POST /api/admin/data-reset returns 403 for non-admin', async () => {
    const salesAgent = request.agent(app);
    await loginAs(salesAgent, 'sales.staff', 'Sales@123');
    const res = await salesAgent.post('/api/admin/data-reset').send({
      presetIds: ['document_sequences'],
      confirmPhrase: 'RESET SELECTED DATA',
    });
    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);
  });

  it('POST /api/admin/data-reset rejects wrong confirm phrase', async () => {
    const res = await agent.post('/api/admin/data-reset').send({
      presetIds: ['document_sequences'],
      confirmPhrase: 'wrong',
    });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  it('POST /api/admin/data-reset clears branch-scoped sequences for admin workspace', async () => {
    const { ensureHumanIdSequencesTable } = await import('./humanId.js');
    ensureHumanIdSequencesTable(db);
    db.prepare(`INSERT INTO human_id_sequences (scope, \`last_value\`) VALUES ('QT|KD|2026', 1), ('QT|MDG|2026', 1)`).run();
    const res = await agent.post('/api/admin/data-reset').send({
      presetIds: ['document_sequences'],
      confirmPhrase: 'RESET SELECTED DATA',
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.branchId).toBeTruthy();
    const remaining = db.prepare('SELECT scope FROM human_id_sequences').all().map((r) => r.scope);
    expect(remaining).toEqual(['QT|MDG|2026']);
  });

  it('POST /api/settings/integration-api-keys then Bearer GET /api/integration/v1/trial-balance', async () => {
    const cre = await agent.post('/api/settings/integration-api-keys').send({ name: 'vitest' });
    expect(cre.status).toBe(201);
    expect(cre.body.ok).toBe(true);
    expect(cre.body.token).toBeTruthy();
    const token = cre.body.token;
    const tb = await request(app)
      .get('/api/integration/v1/trial-balance?startDate=2026-01-01&endDate=2026-01-31')
      .set('Authorization', `Bearer ${token}`);
    expect(tb.status).toBe(200);
    expect(tb.body.ok).toBe(true);
    const row = db.prepare('SELECT id FROM integration_api_keys WHERE revoked_at_iso IS NULL LIMIT 1').get();
    expect(row?.id).toBeTruthy();
    const rev = await agent.patch(`/api/settings/integration-api-keys/${encodeURIComponent(row.id)}/revoke`).send({});
    expect(rev.status).toBe(200);
    const tb2 = await request(app)
      .get('/api/integration/v1/trial-balance?startDate=2026-01-01&endDate=2026-01-31')
      .set('Authorization', `Bearer ${token}`);
    expect(tb2.status).toBe(401);
  });

  it('POST /api/finance/collections-follow-up creates work item', async () => {
    const fin = request.agent(app);
    await loginAs(fin, 'finance.manager', 'Finance@123');
    const res = await fin.post('/api/finance/collections-follow-up').send({
      customerId: 'CUST-UAT-1',
      customerName: 'UAT Customer',
      note: 'Call back Friday',
    });
    expect(res.status).toBe(201);
    expect(res.body.ok).toBe(true);
    expect(res.body.item?.id).toBeTruthy();
  });

  it('GET /api/gl/activity accepts optional costCenter filter', async () => {
    const j = await agent.post('/api/gl/journal').send({
      entryDateISO: '2030-06-15',
      memo: 'vitest cost center',
      lines: [
        { accountCode: '6100', debitNgn: 1000, memo: 'line', costCenter: 'UAT-CC' },
        { accountCode: '1000', creditNgn: 1000, memo: 'line', costCenter: 'UAT-CC' },
      ],
    });
    expect(j.status).toBe(201);
    expect(j.body.ok).toBe(true);
    const filtered = await agent.get('/api/gl/activity?startDate=2030-06-01&endDate=2030-06-30&costCenter=UAT-CC');
    expect(filtered.status).toBe(200);
    expect(filtered.body.ok).toBe(true);
    expect(Array.isArray(filtered.body.lines)).toBe(true);
    expect(filtered.body.lines.length).toBeGreaterThan(0);
    for (const l of filtered.body.lines) {
      expect(String(l.costCenter || '').trim()).toBe('UAT-CC');
    }
  });

  it.skipIf(!mysqlOk)('material incident draft submit approve posts pool and tracks balance', async () => {
    const create = await agent.post('/api/material-incidents').send({
      incidentType: 'yard_offcut',
      materialFamily: 'aluminium',
      productID: 'COIL-ALU',
      gaugeLabel: '0.45mm',
      colour: 'Traffic Black',
      dateISO: '2026-04-01',
      storekeeperDisplay: 'Store Test',
      operatorDisplay: 'Op Test',
      lines: [{ lengthM: 40, quantity: 3, conditionNote: 'Stained sections' }],
      returnDisposition: 'offcut_pool',
    });
    expect(create.status).toBe(201);
    expect(create.body.ok).toBe(true);
    const id = create.body.id;
    expect(id).toMatch(/^MEX-/);

    const submit = await agent.post(`/api/material-incidents/${encodeURIComponent(id)}/submit`).send({});
    expect(submit.status).toBe(200);

    const approve = await agent.post(`/api/material-incidents/${encodeURIComponent(id)}/approve`).send({
      managerRemark: 'Approved for yard register',
    });
    expect(approve.status).toBe(200);
    expect(approve.body.incident.status).toBe('posted');
    expect(approve.body.incident.metersAvailable).toBeCloseTo(120, 2);

    const pool = await agent.get('/api/material-incidents/pool-summary');
    expect(pool.status).toBe(200);
    const found = (pool.body.incidents || []).find((i) => i.id === id);
    expect(found?.metersAvailable).toBeCloseTo(120, 2);

    const print = await agent.get(`/api/material-incidents/${encodeURIComponent(id)}/print-payload`);
    expect(print.status).toBe(200);
    expect(print.body.payload.watermark).toBe('OFFICIAL');

    const issue = await agent.post(`/api/material-incidents/${encodeURIComponent(id)}/issue`).send({
      meters: 30,
      targetKind: 'scrap',
      note: 'Test issue',
    });
    expect(issue.status).toBe(200);
    expect(issue.body.incident.metersAvailable).toBeCloseTo(90, 2);

    const overIssue = await agent.post(`/api/material-incidents/${encodeURIComponent(id)}/issue`).send({
      meters: 500,
      targetKind: 'scrap',
    });
    expect(overIssue.status).toBe(400);
  });

  it.skipIf(!mysqlOk)('material incident reject leaves pool empty', async () => {
    const create = await agent.post('/api/material-incidents').send({
      incidentType: 'yard_offcut',
      materialFamily: 'aluminium',
      productID: 'COIL-ALU',
      gaugeLabel: '0.45mm',
      colour: 'Traffic Black',
      dateISO: '2026-04-02',
      storekeeperDisplay: 'Store Test',
      operatorDisplay: 'Op Test',
      lines: [{ lengthM: 10, quantity: 2 }],
      returnDisposition: 'offcut_pool',
    });
    expect(create.status).toBe(201);
    const id = create.body.id;
    await agent.post(`/api/material-incidents/${encodeURIComponent(id)}/submit`).send({});
    const reject = await agent.post(`/api/material-incidents/${encodeURIComponent(id)}/reject`).send({
      managerRemark: 'Not acceptable',
    });
    expect(reject.status).toBe(200);
    expect(reject.body.incident.status).toBe('rejected');
    const pool = await agent.get('/api/material-incidents/pool-summary');
    expect((pool.body.incidents || []).find((i) => i.id === id)).toBeUndefined();
  });

  it.skipIf(!mysqlOk)('material incident reports loss and aging endpoints', async () => {
    const loss = await agent.get('/api/material-incidents/reports/loss');
    expect(loss.status).toBe(200);
    expect(Array.isArray(loss.body.rows)).toBe(true);
    const aging = await agent.get('/api/material-incidents/reports/aging');
    expect(aging.status).toBe(200);
    expect(Array.isArray(aging.body.rows)).toBe(true);
    const recon = await agent.get('/api/material-incidents/reports/reconciliation');
    expect(recon.status).toBe(200);
    expect(typeof recon.body.totalMetersAvailable).toBe('number');
  });

  it('GET /api/hr/policy-requirements returns required policies', async () => {
    const res = await agent.get('/api/hr/policy-requirements');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.required)).toBe(true);
    expect(Array.isArray(res.body.missing)).toBe(true);
  });

  it('GET /api/hr/staff redacts salary for branch manager', async () => {
    const bm = request.agent(app);
    await loginAs(bm, 'sales.manager', 'Sales@123');
    const res = await bm.get('/api/hr/staff');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const withSalary = (res.body.staff || []).find((s) => Number(s.baseSalaryNgn) > 0);
    if (withSalary) {
      expect(withSalary.baseSalaryNgn).toBeNull();
      expect(withSalary.compensationRedacted).toBe(true);
    }
  });

  it('GET /api/hr/staff shows salary for admin', async () => {
    const res = await agent.get('/api/hr/staff');
    expect(res.status).toBe(200);
    const withSalary = (res.body.staff || []).find((s) => s.userId && s.baseSalaryNgn != null);
    if (withSalary) {
      expect(Number(withSalary.baseSalaryNgn)).toBeGreaterThan(0);
    }
  });
});
