import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { acquireIntegrationHarness, releaseIntegrationHarness } from './testIntegrationHarness.js';
import './vitestSecurityAuditSetup.js';
import { canManageNotices } from './officialNoticesOps.js';
import { publicApplyToJob } from './hrRecruiting.js';

function parseCookieValue(setCookieHeaders, name) {
  const list = Array.isArray(setCookieHeaders) ? setCookieHeaders : [];
  const row = list.find((c) => String(c).startsWith(`${name}=`));
  if (!row) return '';
  return String(row).slice(`${name}=`.length).split(';')[0];
}

const PROBE_PATHS_PUBLIC = ['/health', '/healthz', '/livez', '/readyz', '/status'];
const PROBE_PATHS_API = ['/api/health', '/api/readyz', '/api/livez', '/api/status'];

describe('audit API smoke', () => {
    let db;
    let app;

    beforeAll(() => {
      ({ db, app } = acquireIntegrationHarness());
      db.prepare(
        `INSERT INTO hr_job_postings (id, title, department, branch_id, status, openings, created_at_iso, updated_at_iso)
         VALUES ('JOB-SMOKE-01', 'Test Role', 'Ops', 'BR-KD', 'open', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
         ON DUPLICATE KEY UPDATE status = 'open'`
      ).run();
    }, 600_000);

    afterAll(() => {
      releaseIntegrationHarness();
    });

    it('GET /health is minimal; GET /api/health includes capabilities', async () => {
      const pub = await request(app).get('/health');
      expect(pub.status).toBe(200);
      expect(pub.body.capabilities).toBeUndefined();

      const api = await request(app).get('/api/health');
      expect(api.status).toBe(200);
      expect(api.body.capabilities?.officeDesk).toBe(true);
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

    it('GET /api/bootstrap requires authentication', async () => {
      const res = await request(app).get('/api/bootstrap');
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('AUTH_REQUIRED');
    });

    it('viewer cannot create official notices', async () => {
      const agent = request.agent(app);
      const login = await agent.post('/api/session/login').send({
        username: 'viewer',
        password: 'Viewer@123456!',
      });
      expect(login.status).toBe(200);
      const csrf = parseCookieValue(login.headers['set-cookie'], 'zarewa_csrf');
      const res = await agent
        .post('/api/official-notices')
        .set('X-CSRF-Token', csrf)
        .send({ title: 'Smoke', content: 'Should fail', targetAllStaff: true });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    });

    it('public careers apply validates input', () => {
      const r = publicApplyToJob(db, 'JOB-SMOKE-01', { fullName: 'A', email: 'bad' });
      expect(r.ok).toBe(false);
    });

    it('permission gates are wired', () => {
      expect(canManageNotices({ roleKey: 'viewer', permissions: ['settings.view'] })).toBe(false);
      expect(canManageNotices({ roleKey: 'md', permissions: [] })).toBe(true);
    });
});
