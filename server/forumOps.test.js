import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createDatabase } from './db.js';
import { DEFAULT_BRANCH_ID } from './branches.js';
import { createForumTopic, listForumTopics, addForumPost } from './forumOps.js';

describe.skipIf(!process.env.ZAREWA_MYSQL_HOST && !process.env.ZAREWA_MYSQL_USER)('forumOps', () => {
  let db;

  beforeEach(() => {
    db = createDatabase(':memory:');
  });

  afterEach(() => {
    db?.close();
  });

  it('creates branch forum topic and post', () => {
    const user = db.prepare(`SELECT id, role_key AS roleKey FROM app_users WHERE username = 'admin'`).get();
    const r = createForumTopic(db, user, {
      scope: 'branch',
      branchId: DEFAULT_BRANCH_ID,
      title: 'Machine issue',
      body: 'Machine has spoiled again',
    });
    expect(r.ok).toBe(true);
    const topics = listForumTopics(db, { branchId: DEFAULT_BRANCH_ID });
    expect(topics.length).toBeGreaterThan(0);
    const post = addForumPost(db, r.topic.id, user, { body: 'Anyone seen the mechanic?' });
    expect(post.ok).toBe(true);
  });

  it('rejects company-wide topic from viewer with settings.view', () => {
    const viewer = { id: 'v1', roleKey: 'viewer', permissions: ['settings.view'] };
    const r = createForumTopic(db, viewer, {
      scope: 'company',
      title: 'All staff',
      body: 'Should not post',
    });
    expect(r.ok).toBe(false);
  });
});
