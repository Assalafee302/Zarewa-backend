import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createDatabase } from '../db.js';
import { createApp } from '../app.js';

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

describe.skipIf(!mysqlOk)('workspace chat HTTP gate', () => {
  let app;
  let db;
  let agent;
  const prev = process.env.ZAREWA_WORKSPACE_ROOMS_ENABLED;

  beforeEach(async () => {
    delete process.env.ZAREWA_WORKSPACE_ROOMS_ENABLED;
    db = createDatabase(':memory:');
    app = createApp(db);
    agent = request.agent(app);
    const login = await agent.post('/api/session/login').send({ username: 'admin', password: 'Admin@123' });
    expect(login.status).toBe(200);
  });

  afterEach(() => {
    if (prev === undefined) delete process.env.ZAREWA_WORKSPACE_ROOMS_ENABLED;
    else process.env.ZAREWA_WORKSPACE_ROOMS_ENABLED = prev;
    db?.close?.();
  });

  it('returns 404 for rooms/presence/realtime while chat is off', async () => {
    for (const path of [
      '/api/workspace/rooms',
      '/api/workspace/activity',
      '/api/workspace/presence',
      '/api/workspace/realtime',
    ]) {
      const res = await agent.get(path);
      expect(res.status, path).toBe(404);
      expect(res.body.code).toBe('WORKSPACE_ROOMS_DISABLED');
    }
  });

  it('still serves branch workspace and desk snapshots', async () => {
    const boot = await agent.get('/api/bootstrap?mode=shell');
    expect(boot.status).toBe(200);
    expect(boot.body.ok).toBe(true);
    expect(boot.body.workspaceProduct?.roomsEnabled).toBe(false);
    expect(Array.isArray(boot.body.workspaceBranches)).toBe(true);

    const rev = await agent.get('/api/workspace/revision');
    expect(rev.status).toBe(200);
  });

  it('when enabled, rooms still require office.use', async () => {
    process.env.ZAREWA_WORKSPACE_ROOMS_ENABLED = '1';
    const res = await agent.get('/api/workspace/rooms');
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('FORBIDDEN');
  });
});
