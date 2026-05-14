import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { createDatabase } from './db.js';
import { createApp } from './app.js';

const PROBE_PATHS = [
  '/api/health',
  '/api/readyz',
  '/api/livez',
  '/api/status',
  '/health',
  '/healthz',
  '/livez',
  '/readyz',
  '/status',
];

describe('liveness / readiness probe paths', () => {
  let app;
  let db;
  beforeEach(() => {
    db = createDatabase(':memory:');
    app = createApp(db);
  });
  afterEach(() => {
    db?.close();
  });

  for (const path of PROBE_PATHS) {
    it(`GET ${path} returns same liveness shape as /api/health`, async () => {
      const res = await request(app).get(path);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
      expect(res.body.service).toBe('zarewa-api');
      expect(res.body.capabilities?.officeDesk).toBe(true);
    });
  }
});
