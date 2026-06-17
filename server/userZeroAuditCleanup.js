/**
 * Find and remove app logins that never appear in the audit trail (never used the system).
 * @module server/userZeroAuditCleanup
 */

import { appendAuditLog } from './controlOps.js';
import { hrTableExists } from './hrTableChecks.js';
import { purgeHrStaffUser } from './hrStaffDuplicateCleanup.js';
import { purgeUserHrOperationalData } from './hrUserOperationalCleanup.js';

export const ZERO_AUDIT_BULK_DELETE_CONFIRM_PHRASE = 'DELETE UNUSED LOGINS';

const PROTECTED_ROLES = new Set(['admin', 'md']);

function tableExists(db, table) {
  try {
    return Boolean(
      db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(String(table || '').trim())
    );
  } catch {
    return hrTableExists(db, table);
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 */
export function countUserAuditTrailActivity(db, userId) {
  const uid = String(userId || '').trim();
  if (!uid) return 0;
  let total = 0;
  if (tableExists(db, 'audit_log')) {
    total +=
      db.prepare(`SELECT COUNT(*) AS c FROM audit_log WHERE actor_user_id = ?`).get(uid)?.c || 0;
  }
  if (tableExists(db, 'hr_audit_events')) {
    total +=
      db.prepare(`SELECT COUNT(*) AS c FROM hr_audit_events WHERE actor_user_id = ?`).get(uid)?.c || 0;
  }
  if (tableExists(db, 'approval_actions')) {
    total +=
      db.prepare(`SELECT COUNT(*) AS c FROM approval_actions WHERE acted_by_user_id = ?`).get(uid)?.c || 0;
  }
  return total;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ actorUserId?: string }} [opts]
 */
export function listZeroAuditUserCandidates(db, opts = {}) {
  const actorUserId = String(opts.actorUserId || '').trim();
  const rows = db
    .prepare(
      `SELECT id AS userId, username, display_name AS displayName, role_key AS roleKey, status,
              created_at_iso AS createdAtIso
       FROM app_users
       ORDER BY lower(username) ASC`
    )
    .all();

  const candidates = [];
  const skipped = [];

  for (const row of rows) {
    const userId = String(row.userId || '').trim();
    if (!userId) continue;
    if (actorUserId && userId === actorUserId) {
      skipped.push({ ...row, reason: 'current_user' });
      continue;
    }
    if (PROTECTED_ROLES.has(String(row.roleKey || '').trim())) {
      skipped.push({ ...row, reason: 'protected_role' });
      continue;
    }
    const activityCount = countUserAuditTrailActivity(db, userId);
    if (activityCount > 0) {
      skipped.push({ ...row, reason: 'has_audit_trail', activityCount });
      continue;
    }
    const hasHrProfile = tableExists(db, 'hr_staff_profiles')
      ? Boolean(db.prepare(`SELECT 1 FROM hr_staff_profiles WHERE user_id = ?`).get(userId))
      : false;
    candidates.push({
      userId,
      username: row.username,
      displayName: row.displayName,
      roleKey: row.roleKey,
      status: row.status,
      createdAtIso: row.createdAtIso,
      hasHrProfile,
      activityCount: 0,
    });
  }

  return {
    ok: true,
    candidates,
    summary: {
      totalUsers: rows.length,
      deletable: candidates.length,
      skipped: skipped.length,
      withHrProfile: candidates.filter((c) => c.hasHrProfile).length,
    },
  };
}

function deleteZeroAuditUser(db, userId, actorUserId) {
  const uid = String(userId || '').trim();
  if (!uid) return { ok: false, error: 'User id required.' };
  if (actorUserId && uid === actorUserId) return { ok: false, error: 'Cannot delete your own account.' };
  if (countUserAuditTrailActivity(db, uid) > 0) {
    return { ok: false, error: 'User now has audit trail activity — skipped.' };
  }
  const row = db.prepare(`SELECT id, username, role_key AS roleKey FROM app_users WHERE id = ?`).get(uid);
  if (!row) return { ok: false, error: 'User not found.' };
  if (PROTECTED_ROLES.has(String(row.roleKey || '').trim())) {
    return { ok: false, error: 'Protected system account.' };
  }

  const hasHrProfile =
    tableExists(db, 'hr_staff_profiles') &&
    Boolean(db.prepare(`SELECT 1 FROM hr_staff_profiles WHERE user_id = ?`).get(uid));

  if (hasHrProfile) {
    return purgeHrStaffUser(db, uid, actorUserId);
  }

  try {
    db.transaction(() => {
      purgeUserHrOperationalData(db, uid);
      db.prepare(`DELETE FROM user_sessions WHERE user_id = ?`).run(uid);
      db.prepare(`DELETE FROM app_users WHERE id = ?`).run(uid);
    })();
    return { ok: true, userId: uid, username: row.username, removedHrProfile: false };
  } catch (e) {
    const msg = String(e?.message || e || '');
    const isFk =
      msg.includes('FOREIGN KEY') || msg.toLowerCase().includes('constraint') || msg.includes('SQLITE_CONSTRAINT');
    return {
      ok: false,
      error: isFk
        ? 'Login is still referenced by other records — merge or reassign links first.'
        : msg || 'Delete failed.',
      userId: uid,
      username: row.username,
    };
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} actor
 * @param {{ confirmPhrase?: string; dryRun?: boolean; userIds?: string[] }} [opts]
 */
export function bulkDeleteZeroAuditUsers(db, actor, opts = {}) {
  const dryRun = opts.dryRun !== false;
  const confirmPhrase = String(opts.confirmPhrase || '').trim();
  if (!dryRun && confirmPhrase !== ZERO_AUDIT_BULK_DELETE_CONFIRM_PHRASE) {
    return { ok: false, error: `Type exactly: ${ZERO_AUDIT_BULK_DELETE_CONFIRM_PHRASE}` };
  }

  const preview = listZeroAuditUserCandidates(db, { actorUserId: actor?.id });
  if (!preview.ok) return preview;

  let targets = preview.candidates;
  if (Array.isArray(opts.userIds) && opts.userIds.length) {
    const allow = new Set(opts.userIds.map((id) => String(id).trim()).filter(Boolean));
    targets = targets.filter((t) => allow.has(t.userId));
  }

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      confirmPhrase: ZERO_AUDIT_BULK_DELETE_CONFIRM_PHRASE,
      candidates: targets,
      summary: {
        ...preview.summary,
        willDelete: targets.length,
      },
    };
  }

  const deleted = [];
  const failed = [];
  for (const t of targets) {
    const r = deleteZeroAuditUser(db, t.userId, actor?.id);
    if (r.ok) {
      deleted.push({
        userId: t.userId,
        username: r.username || t.username,
        removedHrProfile: Boolean(t.hasHrProfile),
      });
    } else {
      failed.push({
        userId: t.userId,
        username: t.username,
        error: r.error || 'Delete failed.',
      });
    }
  }

  if (deleted.length && actor) {
    try {
      appendAuditLog(db, {
        actor,
        action: 'user.bulk_delete_zero_audit',
        entityKind: 'app_users',
        entityId: 'bulk',
        note: `Removed ${deleted.length} unused login(s) with zero audit trail`,
        details: { deleted: deleted.map((d) => d.username), failed: failed.length },
      });
    } catch {
      /* audit row is best-effort after bulk delete */
    }
  }

  return {
    ok: true,
    dryRun: false,
    deleted,
    failed,
    summary: {
      attempted: targets.length,
      deleted: deleted.length,
      failed: failed.length,
    },
  };
}
