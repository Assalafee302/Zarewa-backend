import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';

const buildCounts = { shell: 0 };

vi.mock('./bootstrap.js', async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    buildShellBootstrap: (...args) => {
      buildCounts.shell += 1;
      return mod.buildShellBootstrap(...args);
    },
  };
});

const { createDatabase } = await import('./db.js');
const { createApp } = await import('./app.js');

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

describe.skipIf(!mysqlOk)('bootstrap poll cache (before build)', () => {
  let app;
  let db;
  let agent;

  beforeEach(() => {
    buildCounts.shell = 0;
    db = createDatabase(':memory:');
    app = createApp(db);
    agent = request.agent(app);
  });

  afterEach(() => {
    db?.close();
  });

  it('second poll=1 shell bootstrap within TTL does not rebuild', async () => {
    await agent.post('/api/session/login').send({ username: 'admin', password: 'Admin@123' });
    const first = await agent.get('/api/bootstrap').query({ mode: 'shell', poll: '1' });
    expect(first.status).toBe(200);
    expect(first.body.ok).toBe(true);
    expect(buildCounts.shell).toBe(1);

    const second = await agent.get('/api/bootstrap').query({ mode: 'shell', poll: '1' });
    expect(second.status).toBe(200);
    expect(second.body.ok).toBe(true);
    expect(buildCounts.shell).toBe(1);
  });
});
