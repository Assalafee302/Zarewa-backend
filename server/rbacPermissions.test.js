import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createDatabase } from './db.js';
import { createApp } from './app.js';
import { DEFAULT_BRANCH_ID } from './branches.js';

describe('RBAC permission regression', () => {
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

  async function loginAs(agent, username, password) {
    const res = await agent.post('/api/session/login').send({ username, password });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    return res;
  }

  it('MD can enable all-branches rollup, but cannot access settings endpoints', async () => {
    const md = request.agent(app);
    await loginAs(md, 'md', 'Md@1234567890!');

    const on = await md.patch('/api/session/workspace').send({ viewAllBranches: true });
    expect(on.status).toBe(200);
    expect(on.body.viewAllBranches).toBe(true);

    const boot = await md.get('/api/bootstrap');
    expect(boot.status).toBe(200);
    expect(boot.body.branchScope).toBe('ALL');

    const setup = await md.get('/api/setup');
    expect(setup.status).toBe(403);

    const financeCore = await md.put('/api/finance/core').send({ ok: true });
    expect(financeCore.status).toBe(403);
  });

  it('Sales staff cannot enable all-branches rollup', async () => {
    const sales = request.agent(app);
    await loginAs(sales, 'sales.staff', 'Sales@123');

    const on = await sales.patch('/api/session/workspace').send({ viewAllBranches: true });
    expect(on.status).toBe(403);

    const patchBranch = await sales.patch('/api/session/workspace').send({ currentBranchId: DEFAULT_BRANCH_ID });
    expect(patchBranch.status).toBe(200);
  });
});

