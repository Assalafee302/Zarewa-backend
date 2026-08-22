import crypto from 'node:crypto';
import { userHasPermission } from './auth.js';

function nowIso() {
  return new Date().toISOString();
}

function newForumId(prefix) {
  return `${prefix}-${crypto.randomUUID()}`;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} actor
 * @param {{ scope?: string; branchId?: string; title?: string; body?: string }} body
 */
const COMPANY_FORUM_ROLE_KEYS = new Set(['md', 'admin', 'ceo', 'hr_admin', 'gmhr', 'chairman']);

export function canCreateCompanyForumTopic(actor) {
  if (!actor) return false;
  const rk = String(actor.roleKey || '').toLowerCase();
  if (COMPANY_FORUM_ROLE_KEYS.has(rk)) return true;
  return userHasPermission(actor, 'notices.manage');
}

/** Branch topics still need office desk access — not any signed-in user. */
export function canCreateBranchForumTopic(actor) {
  if (!actor) return false;
  if (canCreateCompanyForumTopic(actor)) return true;
  return userHasPermission(actor, 'office.use') || userHasPermission(actor, 'notices.manage');
}

export function createForumTopic(db, actor, body = {}) {
  const scope = String(body.scope || 'branch').toLowerCase();
  if (scope === 'company' && !canCreateCompanyForumTopic(actor)) {
    return { ok: false, error: 'Only senior staff can open company-wide forum topics.' };
  }
  if (scope !== 'company' && !canCreateBranchForumTopic(actor)) {
    return { ok: false, error: 'Office desk access is required to open branch forum topics.' };
  }
  const title = String(body.title || '').trim();
  const content = String(body.body || '').trim();
  if (!title || !content) return { ok: false, error: 'Title and message are required.' };

  const id = newForumId('TOPIC');
  const branchId = scope === 'company' ? null : String(body.branchId || '').trim() || null;

  db.prepare(
    `INSERT INTO forum_topics (id, scope, branch_id, title, created_by_user_id, status, created_at_iso, updated_at_iso)
     VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`
  ).run(id, scope, branchId, title, actor.id, nowIso(), nowIso());

  db.prepare(
    `INSERT INTO forum_posts (id, topic_id, author_user_id, body, attachments_json, created_at_iso)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(newForumId('POST'), id, actor.id, content, JSON.stringify(body.attachments || []), nowIso());

  return { ok: true, topic: { id, title, scope, branchId } };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ scope?: string; branchId?: string }} filters
 */
export function listForumTopics(db, filters = {}) {
  const scope = filters.scope ? String(filters.scope) : null;
  const branchId = String(filters.branchId || '').trim();
  let sql = `SELECT id, scope, branch_id AS branchId, title, created_by_user_id AS createdByUserId,
                    status, created_at_iso AS createdAtIso, updated_at_iso AS updatedAtIso
             FROM forum_topics WHERE status != 'removed'`;
  const params = [];
  if (scope) {
    sql += ` AND scope = ?`;
    params.push(scope);
  }
  if (branchId) {
    sql += ` AND (scope = 'company' OR branch_id = ? OR branch_id IS NULL)`;
    params.push(branchId);
  }
  sql += ` ORDER BY updated_at_iso DESC LIMIT 100`;
  return db.prepare(sql).all(...params);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} topicId
 * @param {object} actor
 * @param {{ body?: string }} body
 */
export function addForumPost(db, topicId, actor, body = {}) {
  const tid = String(topicId || '').trim();
  const topic = db.prepare(`SELECT id FROM forum_topics WHERE id = ? AND status != 'removed'`).get(tid);
  if (!topic) return { ok: false, error: 'Topic not found.' };
  const content = String(body.body || '').trim();
  if (!content) return { ok: false, error: 'Message is required.' };
  const postId = newForumId('POST');
  db.prepare(
    `INSERT INTO forum_posts (id, topic_id, author_user_id, body, attachments_json, created_at_iso)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(postId, tid, actor.id, content, JSON.stringify(body.attachments || []), nowIso());
  db.prepare(`UPDATE forum_topics SET updated_at_iso = ? WHERE id = ?`).run(nowIso(), tid);
  return { ok: true, postId };
}
