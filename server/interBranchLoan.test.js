import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createDatabase } from './db.js';
import { createApp } from './app.js';

describe('Inter-branch lending', () => {
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

  async function login(agent, username, password) {
    const res = await agent.post('/api/session/login').send({ username, password });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  }

  it('finance proposes, MD approves (treasury moves), repayment closes loan', async () => {
    const admin = request.agent(app);
    await login(admin, 'admin', 'Admin@123');
    const boot = await admin.get('/api/bootstrap');
    expect(boot.status).toBe(200);
    const branches = boot.body.workspaceBranches || [];
    expect(branches.length).toBeGreaterThanOrEqual(2);
    const branchA = branches[0].id;
    const branchB = branches[1].id;
    const accounts = boot.body.treasuryAccounts || [];
    expect(accounts.length).toBeGreaterThanOrEqual(2);
    const fromId = accounts[0].id;
    const toId = accounts[1].id;
    const balBeforeFrom = Number(accounts[0].balance) || 0;

    const fin = request.agent(app);
    await login(fin, 'finance.manager', 'Finance@123');

    const create = await fin.post('/api/inter-branch-loans').send({
      lenderBranchId: branchA,
      borrowerBranchId: branchB,
      fromTreasuryAccountId: fromId,
      toTreasuryAccountId: toId,
      principalNgn: 100_000,
      dateISO: '2026-04-01',
      reference: 'TEST-IBL-1',
      proposedNote: 'Working capital support',
      repaymentPlan: [{ dueDateISO: '2026-05-01', amountNgn: 50_000, note: 'First' }],
    });
    expect(create.status).toBe(201);
    expect(create.body.ok).toBe(true);
    const loanId = create.body.loanId;
    expect(loanId).toBeTruthy();

    const md = request.agent(app);
    await login(md, 'md', 'Md@1234567890!');
    const approve = await md.post(`/api/inter-branch-loans/${encodeURIComponent(loanId)}/md-approve`).send({});
    expect(approve.status).toBe(200);
    expect(approve.body.ok).toBe(true);

    const boot2 = await admin.get('/api/bootstrap');
    const accFrom = boot2.body.treasuryAccounts.find((a) => a.id === fromId);
    expect(Number(accFrom.balance)).toBe(balBeforeFrom - 100_000);

    const repay = await fin.post(`/api/inter-branch-loans/${encodeURIComponent(loanId)}/repay`).send({
      amountNgn: 100_000,
      dateISO: '2026-04-02',
      fromTreasuryAccountId: toId,
      toTreasuryAccountId: fromId,
      note: 'Full settlement',
    });
    expect(repay.status).toBe(200);
    expect(repay.body.ok).toBe(true);
    expect(repay.body.loan?.status).toBe('closed');
  });

  it('sales staff cannot propose inter-branch loans', async () => {
    const sales = request.agent(app);
    await login(sales, 'sales.staff', 'Sales@123');
    const res = await sales.post('/api/inter-branch-loans').send({
      lenderBranchId: 'x',
      borrowerBranchId: 'y',
      fromTreasuryAccountId: 1,
      toTreasuryAccountId: 2,
      principalNgn: 1,
      dateISO: '2026-04-01',
    });
    expect(res.status).toBe(403);
  });

  it('finance manager cannot MD-approve', async () => {
    const fin = request.agent(app);
    await login(fin, 'finance.manager', 'Finance@123');
    const admin = request.agent(app);
    await login(admin, 'admin', 'Admin@123');
    const boot = await admin.get('/api/bootstrap');
    const branches = boot.body.workspaceBranches || [];
    const accounts = boot.body.treasuryAccounts || [];
    const create = await fin.post('/api/inter-branch-loans').send({
      lenderBranchId: branches[0].id,
      borrowerBranchId: branches[1].id,
      fromTreasuryAccountId: accounts[0].id,
      toTreasuryAccountId: accounts[1].id,
      principalNgn: 5000,
      dateISO: '2026-04-01',
    });
    expect(create.status).toBe(201);
    const loanId = create.body.loanId;
    const bad = await fin.post(`/api/inter-branch-loans/${encodeURIComponent(loanId)}/md-approve`).send({});
    expect(bad.status).toBe(403);
  });
});
