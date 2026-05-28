/**
 * Short-lived HR sensitive-data unlock after password re-verification.
 * @module server/hrSensitiveGate
 */

import crypto from 'node:crypto';
import { verifyUserPassword } from './auth.js';
import { appendHrAuditEvent, hrTablesReady } from './hrOps.js';

const TOKEN_TTL_MS = 15 * 60 * 1000;

function nowIso() {
  return new Date().toISOString();
}

function newToken() {
  return crypto.randomBytes(24).toString('hex');
}

/** @param {import('better-sqlite3').Database} db */
export function ensureHrSensitiveTokensTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS hr_sensitive_tokens (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      purpose TEXT NOT NULL DEFAULT 'general',
      created_at_iso TEXT NOT NULL,
      expires_at_iso TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES app_users(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_hr_sensitive_tokens_user ON hr_sensitive_tokens(user_id, expires_at_iso DESC);
  `);
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function pruneExpiredHrSensitiveTokens(db) {
  try {
    db.prepare(`DELETE FROM hr_sensitive_tokens WHERE expires_at_iso < ?`).run(nowIso());
  } catch {
    /* table may not exist yet */
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 * @param {string} password
 * @param {{ purpose?: string }} [opts]
 */
export function issueHrSensitiveToken(db, userId, password, opts = {}) {
  const uid = String(userId || '').trim();
  if (!uid) return { ok: false, error: 'Not signed in.' };
  const check = verifyUserPassword(db, uid, password);
  if (!check.ok) return check;

  ensureHrSensitiveTokensTable(db);
  pruneExpiredHrSensitiveTokens(db);

  const token = newToken();
  const created = nowIso();
  const expires = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
  const purpose = String(opts.purpose || 'general').trim().slice(0, 40) || 'general';

  db.prepare(
    `INSERT INTO hr_sensitive_tokens (token, user_id, purpose, created_at_iso, expires_at_iso) VALUES (?,?,?,?,?)`
  ).run(token, uid, purpose, created, expires);

  if (hrTablesReady(db)) {
    appendHrAuditEvent(db, {
      actorUserId: uid,
      action: 'hr.sensitive.unlock',
      entityKind: 'hr_sensitive_token',
      entityId: token.slice(0, 12),
      details: { purpose, expiresAtIso: expires },
    });
  }

  return { ok: true, token, expiresAtIso: expires, ttlSeconds: Math.floor(TOKEN_TTL_MS / 1000) };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 * @param {string} token
 */
export function validateHrSensitiveToken(db, userId, token) {
  const uid = String(userId || '').trim();
  const t = String(token || '').trim();
  if (!uid || !t) return false;
  try {
    pruneExpiredHrSensitiveTokens(db);
    const row = db
      .prepare(
        `SELECT token FROM hr_sensitive_tokens WHERE token = ? AND user_id = ? AND expires_at_iso >= ?`
      )
      .get(t, uid, nowIso());
    return Boolean(row);
  } catch {
    return false;
  }
}

/**
 * Express middleware: optional header `x-hr-sensitive-token` sets req.hrSensitiveUnlocked.
 * @param {import('better-sqlite3').Database} db
 */
export function hrSensitiveTokenMiddleware(db) {
  return (req, _res, next) => {
    req.hrSensitiveUnlocked = false;
    const token = String(req.headers['x-hr-sensitive-token'] || '').trim();
    if (token && req.user?.id && validateHrSensitiveToken(db, req.user.id, token)) {
      req.hrSensitiveUnlocked = true;
    }
    next();
  };
}
