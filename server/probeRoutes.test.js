import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { createDatabase } from './db.js';
import { createApp } from './app.js';

const PROBE_PATHS_PUBLIC = ['/health', '/healthz', '/livez', '/readyz', '/status'];
const PROBE_PATHS_API = ['/api/health', '/api/readyz', '/api/livez', '/api/status'];

describe('liveness / readiness probe paths', () => {
  let app;
  let db;

  beforeAll(() => {
    db = createDatabase(':memory:');
    app = createApp(db);
  }, 600_000);

  afterAll(() => {
    db?.close();
  });

  for (const path of PROBE_PATHS_PUBLIC) {
    it(`GET ${path} returns minimal public liveness`, async () => {
      const res = await request(app).get(path);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.service).toBe('zarewa-api');
      expect(res.body.capabilities).toBeUndefined();
    });
  }

  for (const path of PROBE_PATHS_API) {
    it(`GET ${path} returns API liveness with capabilities`, async () => {
      const res = await request(app).get(path);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.service).toBe('zarewa-api');
      expect(res.body.capabilities?.officeDesk).toBe(true);
    });
  }
});
