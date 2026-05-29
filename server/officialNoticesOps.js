import { userHasPermission } from './auth.js';
function nowIso() {
  return new Date().toISOString();
}

function canManageNotices(user) {
  if (!user) return false;
  const rk = String(user.roleKey || '').toLowerCase();
  if (rk === 'md' || rk === 'admin' || rk === 'hr_admin' || rk === 'gmhr') return true;
  return userHasPermission(user, 'settings.view');
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} actor
 * @param {object} body
 */
export function createOfficialNotice(db, actor, body = {}) {
  if (!canManageNotices(actor)) return { ok: false, error: 'Not allowed to create official notices.' };
  const title = String(body.title || '').trim();
  const content = String(body.content || '').trim();
  if (!title || !content) return { ok: false, error: 'Title and content are required.' };

  const id = `NOTICE-${Date.now()}`;
  const targets = {
    allStaff: Boolean(body.targetAllStaff ?? true),
    branchIds: Array.isArray(body.branchIds) ? body.branchIds.map(String) : [],
    roleKeys: Array.isArray(body.roleKeys) ? body.roleKeys.map(String) : [],
    departments: Array.isArray(body.departments) ? body.departments.map(String) : [],
  };

  db.prepare(
    `INSERT INTO official_notices (
      id, title, content, created_by_user_id, targets_json, requires_acknowledgement,
      pinned, expires_at_iso, attachments_json, created_at_iso, updated_at_iso
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    title,
    content,
    actor.id,
    JSON.stringify(targets),
    body.requiresAcknowledgement ? 1 : 0,
    body.pinned ? 1 : 0,
    body.expiresAtIso || null,
    JSON.stringify(body.attachments || []),
    nowIso(),
    nowIso()
  );

  return { ok: true, notice: { id, title, content, targets, requiresAcknowledgement: Boolean(body.requiresAcknowledgement) } };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} user
 * @param {{ branchId?: string }} scope
 */
export function listOfficialNoticesForUser(db, user, scope = {}) {
  const rows = db
    .prepare(
      `SELECT id, title, content, targets_json AS targetsJson, requires_acknowledgement AS requiresAcknowledgement,
              pinned, expires_at_iso AS expiresAtIso, created_at_iso AS createdAtIso
       FROM official_notices
       WHERE expires_at_iso IS NULL OR expires_at_iso > ?
       ORDER BY pinned DESC, created_at_iso DESC
       LIMIT 200`
    )
    .all(nowIso());

  const branchId = String(scope.branchId || '').trim();
  const roleKey = String(user?.roleKey || '').toLowerCase();

  return rows.filter((row) => {
    let targets = {};
    try {
      targets = JSON.parse(row.targetsJson || '{}');
    } catch {
      return true;
    }
    if (targets.allStaff) return true;
    if (branchId && Array.isArray(targets.branchIds) && targets.branchIds.length) {
      if (!targets.branchIds.includes(branchId)) return false;
    }
    if (Array.isArray(targets.roleKeys) && targets.roleKeys.length) {
      if (!targets.roleKeys.map((r) => String(r).toLowerCase()).includes(roleKey)) return false;
    }
    return true;
  });
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} noticeId
 * @param {object} user
 */
export function acknowledgeOfficialNotice(db, noticeId, user) {
  const id = String(noticeId || '').trim();
  const notice = db.prepare(`SELECT id, requires_acknowledgement FROM official_notices WHERE id = ?`).get(id);
  if (!notice) return { ok: false, error: 'Notice not found.' };
  db.prepare(
    `INSERT INTO official_notice_acknowledgements (notice_id, user_id, acknowledged_at_iso)
     VALUES (?, ?, ?)
     ON CONFLICT(notice_id, user_id) DO UPDATE SET acknowledged_at_iso = excluded.acknowledged_at_iso`
  ).run(id, user.id, nowIso());
  return { ok: true };
}
