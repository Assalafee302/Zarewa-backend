import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import { acquireIntegrationHarness, releaseIntegrationHarness } from './testIntegrationHarness.js';
import './vitestSecurityAuditSetup.js';
import { canManageNotices, createOfficialNotice } from './officialNoticesOps.js';
import { canCreateCompanyForumTopic, createForumTopic } from './forumOps.js';

function parseCookieValue(setCookieHeaders, name) {
  const list = Array.isArray(setCookieHeaders) ? setCookieHeaders : [];
  const row = list.find((c) => String(c).startsWith(`${name}=`));
  if (!row) return '';
  return String(row).slice(`${name}=`.length).split(';')[0];
}

describe('official notices and company forum authorization', () => {
    let db;
    let app;

    beforeAll(() => {
      ({ db, app } = acquireIntegrationHarness());
    }, 600_000);

    afterAll(() => {
      releaseIntegrationHarness();
    });

    it('canManageNotices denies settings.view-only users', () => {
      expect(
        canManageNotices({ roleKey: 'viewer', permissions: ['settings.view', 'audit.view'] })
      ).toBe(false);
    });

    it('canManageNotices allows MD and notices.manage', () => {
      expect(canManageNotices({ roleKey: 'md', permissions: [] })).toBe(true);
      expect(canManageNotices({ roleKey: 'hr_staff', permissions: ['notices.manage'] })).toBe(true);
    });

    it('viewer cannot create official notices via API', async () => {
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
        .send({ title: 'Test notice', content: 'Broadcast body', targetAllStaff: true });
      expect(res.status).toBe(400);
      expect(res.body.ok).toBe(false);
    });

    it('createOfficialNotice succeeds for admin', () => {
      const admin = db.prepare(`SELECT id, role_key AS roleKey FROM app_users WHERE username = 'admin'`).get();
      const r = createOfficialNotice(db, admin, {
        title: 'Holiday',
        content: 'Office closed Monday',
        targetAllStaff: true,
      });
      expect(r.ok).toBe(true);
    });

    it('settings.view user cannot open company forum topic', () => {
      const user = { id: 'u-view', roleKey: 'viewer', permissions: ['settings.view'] };
      expect(canCreateCompanyForumTopic(user)).toBe(false);
      const r = createForumTopic(db, user, {
        scope: 'company',
        title: 'All hands',
        body: 'Company update',
      });
      expect(r.ok).toBe(false);
    });
});
