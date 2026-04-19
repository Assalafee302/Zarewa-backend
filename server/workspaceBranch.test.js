import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { createDatabase } from './db.js';
import { createApp } from './app.js';
import { DEFAULT_BRANCH_ID } from './branches.js';

const openDbs = [];

function makeApp() {
  const db = createDatabase(':memory:');
  openDbs.push(db);
  return createApp(db);
}

describe('Session workspace / branch scope', () => {
  afterAll(() => {
    for (const db of openDbs) db.close();
    openDbs.length = 0;
  });

  it('bootstrap includes workspaceBranches and branchScope; PATCH branch updates scope', async () => {
    const app = makeApp();
    const agent = request.agent(app);
    const login = await agent.post('/api/session/login').send({ username: 'admin', password: 'Admin@123' });
    expect(login.status).toBe(200);

    const boot0 = await agent.get('/api/bootstrap');
    expect(boot0.status).toBe(200);
    expect(Array.isArray(boot0.body.workspaceBranches)).toBe(true);
    expect(boot0.body.workspaceBranches.length).toBeGreaterThan(0);
    expect(boot0.body.branchScope).toBeTruthy();

    const bad = await agent.patch('/api/session/workspace').send({ currentBranchId: 'BR-NONEXISTENT' });
    expect(bad.status).toBe(400);

    const patch = await agent.patch('/api/session/workspace').send({ currentBranchId: DEFAULT_BRANCH_ID });
    expect(patch.status).toBe(200);
    expect(patch.body.ok).toBe(true);
    expect(patch.body.currentBranchId).toBe(DEFAULT_BRANCH_ID);

    const boot1 = await agent.get('/api/bootstrap');
    expect(boot1.status).toBe(200);
    expect(boot1.body.branchScope).toBe(DEFAULT_BRANCH_ID);
  });

  it('admin can enable HQ all-branches rollup when permitted', async () => {
    const app = makeApp();
    const agent = request.agent(app);
    await agent.post('/api/session/login').send({ username: 'admin', password: 'Admin@123' });

    const on = await agent.patch('/api/session/workspace').send({ viewAllBranches: true });
    expect(on.status).toBe(200);
    expect(on.body.viewAllBranches).toBe(true);

    const boot = await agent.get('/api/bootstrap');
    expect(boot.status).toBe(200);
    expect(boot.body.branchScope).toBe('ALL');

    const off = await agent.patch('/api/session/workspace').send({ viewAllBranches: false });
    expect(off.status).toBe(200);
    expect(off.body.viewAllBranches).toBe(false);
  });

  it('procurement role cannot enable HQ rollup', async () => {
    const app = makeApp();
    const agent = request.agent(app);
    await agent.post('/api/session/login').send({ username: 'procurement', password: 'Procure@123' });

    const on = await agent.patch('/api/session/workspace').send({ viewAllBranches: true });
    expect(on.status).toBe(403);
  });
});
