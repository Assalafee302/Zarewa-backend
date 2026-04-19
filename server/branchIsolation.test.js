import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createDatabase } from './db.js';
import { createApp } from './app.js';

describe('Branch isolation and rollups', () => {
  let db;
  let app;

  beforeEach(() => {
    db = createDatabase(':memory:');
    app = createApp(db);
  });

  afterEach(() => {
    db?.close();
    db = undefined;
    app = undefined;
  });

  it('branch-only bootstrap is isolated; view-all aggregates', async () => {
    const agent = request.agent(app);
    const login = await agent.post('/api/session/login').send({ username: 'admin', password: 'Admin@123' });
    expect(login.status).toBe(200);

    const boot0 = await agent.get('/api/bootstrap');
    expect(boot0.status).toBe(200);
    const branches = boot0.body.workspaceBranches || [];
    expect(branches.length).toBeGreaterThanOrEqual(2);

    const branchA = branches[0].id;
    const branchB = branches[1].id;

    const setA = await agent.patch('/api/session/workspace').send({ currentBranchId: branchA, viewAllBranches: false });
    expect(setA.status).toBe(200);

    const ca = await agent.post('/api/customers').send({
      customerID: 'CUS-BR-A',
      name: 'Branch A Customer',
      phoneNumber: '08000001001',
      email: 'branch-a@example.com',
      addressShipping: 'A',
      addressBilling: 'A',
      status: 'Active',
      tier: 'Retail',
      paymentTerms: 'Cash',
    });
    expect(ca.status).toBe(201);

    const setB = await agent.patch('/api/session/workspace').send({ currentBranchId: branchB, viewAllBranches: false });
    expect(setB.status).toBe(200);

    const cb = await agent.post('/api/customers').send({
      customerID: 'CUS-BR-B',
      name: 'Branch B Customer',
      phoneNumber: '08000001002',
      email: 'branch-b@example.com',
      addressShipping: 'B',
      addressBilling: 'B',
      status: 'Active',
      tier: 'Retail',
      paymentTerms: 'Cash',
    });
    expect(cb.status).toBe(201);

    const bootB = await agent.get('/api/bootstrap');
    expect(bootB.status).toBe(200);
    expect(bootB.body.branchScope).toBe(branchB);
    const idsB = (bootB.body.customers || []).map((c) => c.customerID);
    expect(idsB).toContain('CUS-BR-B');
    expect(idsB).not.toContain('CUS-BR-A');

    const viewAll = await agent.patch('/api/session/workspace').send({ viewAllBranches: true });
    expect(viewAll.status).toBe(200);

    const bootAll = await agent.get('/api/bootstrap');
    expect(bootAll.status).toBe(200);
    expect(bootAll.body.branchScope).toBe('ALL');
    const idsAll = (bootAll.body.customers || []).map((c) => c.customerID);
    expect(idsAll).toContain('CUS-BR-A');
    expect(idsAll).toContain('CUS-BR-B');
  });

  it('CEO can enable all-branches rollup and sees aggregated bootstrap data', async () => {
    const ceo = request.agent(app);
    const login = await ceo.post('/api/session/login').send({ username: 'ceo', password: 'Ceo@1234567890!' });
    expect(login.status).toBe(200);
    expect(login.body.permissions || []).toContain('hq.view_all_branches');

    const on = await ceo.patch('/api/session/workspace').send({ viewAllBranches: true });
    expect(on.status).toBe(200);
    expect(on.body.viewAllBranches).toBe(true);

    const boot = await ceo.get('/api/bootstrap');
    expect(boot.status).toBe(200);
    expect(boot.body.branchScope).toBe('ALL');
  });
});

