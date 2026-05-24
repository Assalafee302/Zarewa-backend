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

  it('rejects cross-branch purchase order status change', async () => {
    const agent = request.agent(app);
    const login = await agent.post('/api/session/login').send({ username: 'admin', password: 'Admin@123' });
    expect(login.status).toBe(200);

    const boot0 = await agent.get('/api/bootstrap');
    const branches = boot0.body.workspaceBranches || [];
    const branchA = branches[0].id;
    const branchB = branches[1].id;

    await agent.patch('/api/session/workspace').send({ currentBranchId: branchA, viewAllBranches: false });

    const sup = await agent.post('/api/suppliers').send({ name: 'Branch ISO Supplier', city: 'Yola' });
    expect(sup.status).toBe(201);
    const sid = sup.body.supplierID;

    const po = await agent.post('/api/purchase-orders').send({
      poID: 'PO-BR-ISO-A',
      supplierID: sid,
      supplierName: 'Branch ISO Supplier',
      orderDateISO: '2026-05-24',
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

    await agent.patch('/api/session/workspace').send({ currentBranchId: branchB, viewAllBranches: false });

    const patch = await agent
      .patch(`/api/purchase-orders/${encodeURIComponent('PO-BR-ISO-A')}/status`)
      .send({ status: 'Approved' });
    expect(patch.status).toBe(403);
  });

  it('blocks quotation and PO create while all-branches view is on', async () => {
    const md = request.agent(app);
    const login = await md.post('/api/session/login').send({ username: 'md', password: 'Md@1234567890!' });
    expect(login.status).toBe(200);

    await md.patch('/api/session/workspace').send({ viewAllBranches: true });
    expect(login.body.permissions || []).toContain('hq.view_all_branches');
    const bootAll = await md.get('/api/bootstrap');
    expect(bootAll.body.branchScope).toBe('ALL');

    const q = await md.post('/api/quotations').send({
      customerID: 'CUS-001',
      projectName: 'Blocked in rollup',
      dateISO: '2026-05-24',
      lines: { products: [{ name: 'Sheet', qty: '1', unitPrice: '1000' }], accessories: [], services: [] },
    });
    expect(q.status).toBe(403);

    const sup = await md.post('/api/suppliers').send({ name: 'Rollup Block Sup', city: 'Kaduna' });
    const po = await md.post('/api/purchase-orders').send({
      supplierID: sup.body.supplierID,
      supplierName: 'Rollup Block Sup',
      orderDateISO: '2026-05-24',
      status: 'Pending',
      lines: [
        {
          lineKey: 'L1',
          productID: 'COIL-ALU',
          productName: 'Coil',
          qtyOrdered: 1,
          unitPricePerKgNgn: 100,
          unitPriceNgn: 100,
          qtyReceived: 0,
        },
      ],
    });
    expect(po.status).toBe(403);

    await md.patch('/api/session/workspace').send({ viewAllBranches: false });
    const qOk = await md.post('/api/quotations').send({
      customerID: 'CUS-001',
      projectName: 'Allowed single branch',
      dateISO: '2026-05-24',
      lines: { products: [{ name: 'Sheet', qty: '1', unitPrice: '1000' }], accessories: [], services: [] },
    });
    expect(qOk.status).toBe(201);
  });

  it('Managing director can enable all-branches rollup and sees aggregated bootstrap data', async () => {
    const md = request.agent(app);
    const login = await md.post('/api/session/login').send({ username: 'md', password: 'Md@1234567890!' });
    expect(login.status).toBe(200);
    expect(login.body.permissions || []).toContain('hq.view_all_branches');

    const on = await md.patch('/api/session/workspace').send({ viewAllBranches: true });
    expect(on.status).toBe(200);
    expect(on.body.viewAllBranches).toBe(true);

    const boot = await md.get('/api/bootstrap');
    expect(boot.status).toBe(200);
    expect(boot.body.branchScope).toBe('ALL');
  });
});

