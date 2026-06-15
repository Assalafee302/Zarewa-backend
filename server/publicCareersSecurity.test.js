import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { acquireIntegrationHarness, releaseIntegrationHarness } from './testIntegrationHarness.js';
import './vitestSecurityAuditSetup.js';
import { publicApplyToJob } from './hrRecruiting.js';

function seedOpenJob(db) {
  db.prepare(
    `INSERT INTO hr_job_postings (id, title, department, branch_id, status, openings, created_at_iso, updated_at_iso)
     VALUES ('JOB-TEST-01', 'Store Officer', 'Operations', 'BR-KD', 'open', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
     ON DUPLICATE KEY UPDATE status = 'open'`
  ).run();
}

describe('public careers security', () => {
    let db;
    let app;

    beforeAll(() => {
      ({ db, app } = acquireIntegrationHarness());
      seedOpenJob(db);
    }, 600_000);

    afterAll(() => {
      releaseIntegrationHarness();
    });

    it('publicApplyToJob rejects invalid email', () => {
      const r = publicApplyToJob(db, 'JOB-TEST-01', {
        fullName: 'Jane Applicant',
        email: 'not-an-email',
      });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/valid email/i);
    });

    it('publicApplyToJob rejects oversized cover note', () => {
      const r = publicApplyToJob(db, 'JOB-TEST-01', {
        fullName: 'Jane Applicant',
        notes: 'x'.repeat(2001),
      });
      expect(r.ok).toBe(false);
      expect(r.error).toMatch(/2000 characters/i);
    });

    it('POST apply returns 400 without fullName', async () => {
      const res = await request(app)
        .post('/api/public/careers/jobs/JOB-TEST-01/apply')
        .send({ email: 'jane@example.com' });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    });

    it('POST apply returns 429 after repeated applications from same IP', async () => {
      db.prepare(
        `INSERT INTO hr_job_postings (id, title, department, branch_id, status, openings, created_at_iso, updated_at_iso)
         VALUES ('JOB-RATE-01', 'Rate Limit Role', 'Ops', 'BR-KD', 'open', 1, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
         ON DUPLICATE KEY UPDATE status = 'open'`
      ).run();
      const body = {
        fullName: 'Jane Applicant',
        email: 'rate-limit@example.com',
        phone: '08000000099',
      };
      for (let i = 0; i < 10; i++) {
        const ok = await request(app).post('/api/public/careers/jobs/JOB-RATE-01/apply').send(body);
        expect([201, 400]).toContain(ok.status);
      }
      const blocked = await request(app).post('/api/public/careers/jobs/JOB-RATE-01/apply').send(body);
      expect(blocked.status).toBe(429);
    });
});
