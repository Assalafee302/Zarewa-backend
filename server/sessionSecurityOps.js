/**
 * Phase 12 — login security reporting (active sessions, failed-login summary).
 * @module server/sessionSecurityOps
 */

function nowIso() {
  return new Date().toISOString();
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function listActiveSessions(db) {
  try {
    return db
      .prepare(
        `SELECT s.session_token, s.user_id, s.created_at_iso, s.last_seen_at_iso, s.expires_at_iso,
                s.current_branch_id, u.username, u.display_name, u.role_key
         FROM user_sessions s
         JOIN app_users u ON u.id = s.user_id
         ORDER BY s.last_seen_at_iso DESC`
      )
      .all()
      .map((row) => ({
        sessionTokenPreview: `${String(row.session_token || '').slice(0, 8)}…`,
        userId: row.user_id,
        username: row.username,
        displayName: row.display_name,
        roleKey: row.role_key,
        createdAtIso: row.created_at_iso,
        lastSeenAtIso: row.last_seen_at_iso,
        expiresAtIso: row.expires_at_iso,
        currentBranchId: row.current_branch_id,
      }));
  } catch {
    return [];
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ hours?: number }} [opts]
 */
export function buildLoginSecuritySummary(db, opts = {}) {
  const hours = Math.min(168, Math.max(1, Number(opts.hours) || 24));
  const since = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
  const now = nowIso();

  const countAction = (action) => {
    try {
      const row = db
        .prepare(
          `SELECT COUNT(*) AS c FROM audit_log WHERE action = ? AND occurred_at_iso >= ?`
        )
        .get(action, since);
      return Number(row?.c) || 0;
    } catch {
      return 0;
    }
  };

  let currentlyLockedAccounts = 0;
  try {
    const cols = db.prepare(`PRAGMA table_info(app_users)`).all();
    if (cols.some((c) => c.name === 'locked_until_iso')) {
      currentlyLockedAccounts =
        Number(
          db
            .prepare(
              `SELECT COUNT(*) AS c FROM app_users
               WHERE locked_until_iso IS NOT NULL AND trim(locked_until_iso) != '' AND locked_until_iso > ?`
            )
            .get(now)?.c
        ) || 0;
    }
  } catch {
    /* ignore */
  }

  let activeSessionCount = 0;
  try {
    activeSessionCount =
      Number(db.prepare(`SELECT COUNT(*) AS c FROM user_sessions WHERE expires_at_iso > ?`).get(now)?.c) ||
      0;
  } catch {
    /* ignore */
  }

  let recentEvents = [];
  try {
    recentEvents = db
      .prepare(
        `SELECT id, occurred_at_iso, actor_name, action, entity_id, note, status
         FROM audit_log
         WHERE action IN ('session.login_failed', 'session.account_locked', 'session.timeout', 'session.login')
           AND occurred_at_iso >= ?
         ORDER BY occurred_at_iso DESC
         LIMIT 80`
      )
      .all(since)
      .map((row) => ({
        id: row.id,
        occurredAtIso: row.occurred_at_iso,
        actorName: row.actor_name ?? '',
        action: row.action,
        entityId: row.entity_id ?? '',
        note: row.note ?? '',
        status: row.status,
      }));
  } catch {
    /* ignore */
  }

  return {
    hours,
    sinceIso: since,
    failedLoginAttempts: countAction('session.login_failed'),
    accountLockEvents: countAction('session.account_locked'),
    successfulLogins: countAction('session.login'),
    sessionTimeouts: countAction('session.timeout'),
    currentlyLockedAccounts,
    activeSessionCount,
    recentEvents,
  };
}
