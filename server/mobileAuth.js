import crypto from 'node:crypto';
import { DEFAULT_BRANCH_ID, listBranches } from './branches.js';
import {
  buildSessionPayload,
  canUseAllBranchesRollup,
  enrichUserWithHrSelfService,
  findAppUserByLoginIdentifier,
  publicUserFromRow,
  requestShouldExtendSession,
  verifyPassword,
  clearAccountLock,
  recordFailedLoginAttempt,
  FAILED_LOGIN_LOCK_THRESHOLD,
  ACCOUNT_LOCK_MINUTES,
  SESSION_WARNING_SECONDS,
  sessionTimeoutMinutes,
} from './auth.js';
import { nowIso } from './hrOps.js';

function sessionSecurityMeta(expiresAtISO) {
  return {
    sessionExpiresAtIso: expiresAtISO,
    sessionTimeoutMinutes: sessionTimeoutMinutes(),
    sessionWarningSeconds: SESSION_WARNING_SECONDS,
  };
}

function addMinutesToIso(iso, minutes) {
  const d = new Date(iso || new Date().toISOString());
  d.setMinutes(d.getMinutes() + Number(minutes) || 0);
  return d.toISOString();
}

function buildLoginFailureAudits(row, username, fail) {
  const audits = [];
  if (row?.id) {
    audits.push({
      actor: { id: 'system', username: 'system', displayName: 'System' },
      action: fail?.locked ? 'auth.login_locked' : 'auth.login_failed',
      entityKind: 'user',
      entityId: row.id,
      note: fail?.locked
        ? `Account locked after failed sign-in (${username})`
        : `Failed sign-in attempt (${username})`,
    });
  }
  return audits;
}

const MOBILE_ACCESS_TTL_DAYS = Number(process.env.MOBILE_ACCESS_TTL_DAYS || 7);
const MOBILE_REFRESH_TTL_DAYS = Number(process.env.MOBILE_REFRESH_TTL_DAYS || 60);

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

function createRawToken() {
  return crypto.randomBytes(32).toString('hex');
}

function mobileSessionId() {
  return `mob_${crypto.randomBytes(12).toString('hex')}`;
}

function defaultBranchIdForDb(db) {
  try {
    const r = db
      .prepare(`SELECT id FROM branches WHERE active = 1 ORDER BY sort_order ASC, id ASC LIMIT 1`)
      .get();
    return r?.id || DEFAULT_BRANCH_ID;
  } catch {
    return DEFAULT_BRANCH_ID;
  }
}

function findMobileSessionByAccessHash(db, accessHash) {
  return db
    .prepare(
      `SELECT s.*, u.id AS uid, u.username, u.display_name, u.email, u.avatar_url, u.role_key,
              u.department, u.status, u.last_login_at_iso, u.created_at_iso, u.workspace_branch_id,
              u.must_change_password, u.training_completed_at_iso
       FROM mobile_auth_sessions s
       JOIN app_users u ON u.id = s.user_id
       WHERE s.access_token_hash = ? AND s.revoked_at_iso IS NULL`
    )
    .get(accessHash);
}

function findMobileSessionByRefreshHash(db, refreshHash) {
  return db
    .prepare(
      `SELECT s.*, u.id AS uid, u.username, u.display_name, u.email, u.avatar_url, u.role_key,
              u.department, u.status, u.last_login_at_iso, u.created_at_iso, u.workspace_branch_id,
              u.must_change_password, u.training_completed_at_iso
       FROM mobile_auth_sessions s
       JOIN app_users u ON u.id = s.user_id
       WHERE s.refresh_token_hash = ? AND s.revoked_at_iso IS NULL`
    )
    .get(refreshHash);
}

function userRowFromMobileJoin(row) {
  if (!row) return null;
  return {
    id: row.uid || row.user_id,
    username: row.username,
    display_name: row.display_name,
    email: row.email,
    avatar_url: row.avatar_url,
    role_key: row.role_key,
    department: row.department,
    status: row.status,
    last_login_at_iso: row.last_login_at_iso,
    created_at_iso: row.created_at_iso,
    workspace_branch_id: row.workspace_branch_id,
    must_change_password: row.must_change_password,
    training_completed_at_iso: row.training_completed_at_iso,
  };
}

function buildMobileSessionContext(db, row, req) {
  const userRow = userRowFromMobileJoin(row);
  if (!userRow || userRow.status !== 'active') return null;

  const user = enrichUserWithHrSelfService(db, publicUserFromRow(userRow));
  const baseBranch = defaultBranchIdForDb(db);
  let currentBranchId = baseBranch;
  if (!canUseAllBranchesRollup(user)) {
    const assigned = String(userRow.workspace_branch_id || '').trim();
    if (assigned) {
      const br = db.prepare(`SELECT id, active FROM branches WHERE id = ?`).get(assigned);
      if (br?.id && Number(br.active) === 1) currentBranchId = assigned;
    }
  }

  const now = nowIso();
  const shouldExtend = requestShouldExtendSession(req);
  const accessExpires = String(row.access_expires_at_iso || '').trim();
  if (accessExpires && accessExpires < now) return null;

  let expiresAtISO = accessExpires || addMinutesToIso(now, MOBILE_ACCESS_TTL_DAYS * 24 * 60);
  if (shouldExtend) {
    expiresAtISO = addMinutesToIso(now, MOBILE_ACCESS_TTL_DAYS * 24 * 60);
    db.prepare(
      `UPDATE mobile_auth_sessions SET last_seen_at_iso = ?, access_expires_at_iso = ? WHERE id = ?`
    ).run(now, expiresAtISO, row.id);
  }

  return {
    user,
    workspaceBranchId: currentBranchId,
    workspaceViewAll: false,
    session: {
      ...buildSessionPayload(user),
      currentBranchId,
      viewAllBranches: false,
      branches: listBranches(db),
      ...sessionSecurityMeta(expiresAtISO),
      authKind: 'mobile',
    },
    mobileSessionId: row.id,
  };
}

export function parseBearerToken(req) {
  const auth = String(req.headers?.authorization || '').trim();
  if (!auth.toLowerCase().startsWith('bearer ')) return '';
  return auth.slice(7).trim();
}

export function resolveMobileAccessToken(db, accessToken, req) {
  const raw = String(accessToken || '').trim();
  if (!raw) return null;
  const row = findMobileSessionByAccessHash(db, hashToken(raw));
  if (!row) return null;
  return buildMobileSessionContext(db, row, req);
}

export function attachMobileAuthContext(db) {
  return (req, res, next) => {
    if (req.user) return next();
    const token = parseBearerToken(req);
    if (!token) return next();
    const ctx = resolveMobileAccessToken(db, token, req);
    if (!ctx) return next();
    req.mobileAuth = true;
    req.mobileSessionId = ctx.mobileSessionId;
    req.user = ctx.user;
    req.session = ctx.session;
    req.workspaceBranchId = ctx.workspaceBranchId;
    req.workspaceViewAll = ctx.workspaceViewAll;
    return next();
  };
}

export function loginMobileWithPassword(db, username, password, deviceMeta = {}) {
  const key = String(username || '').trim().toLowerCase();
  const row = findAppUserByLoginIdentifier(db, key);
  if (!row || row.status !== 'active') {
    return {
      ok: false,
      error: 'Invalid username or password.',
      code: 'INVALID_CREDENTIALS',
      audits: buildLoginFailureAudits(row, key, { locked: false, attemptCount: null }),
    };
  }

  const lockedUntil = String(row.locked_until_iso ?? '').trim();
  if (lockedUntil && lockedUntil > nowIso()) {
    return {
      ok: false,
      error: `Account locked after too many failed sign-in attempts. Try again after ${new Date(lockedUntil).toLocaleString()}.`,
      code: 'ACCOUNT_LOCKED',
      lockedUntilIso: lockedUntil,
    };
  }
  if (lockedUntil && lockedUntil <= nowIso()) {
    clearAccountLock(db, row.id);
  }

  if (!verifyPassword(password, row.password_hash)) {
    const fresh = db.prepare(`SELECT * FROM app_users WHERE id = ?`).get(row.id);
    const fail = recordFailedLoginAttempt(db, fresh || row);
    return {
      ok: false,
      error: fail.locked
        ? `Account locked after ${FAILED_LOGIN_LOCK_THRESHOLD} failed attempts. Try again in ${ACCOUNT_LOCK_MINUTES} minutes.`
        : 'Invalid username or password.',
      code: fail.locked ? 'ACCOUNT_LOCKED' : 'INVALID_CREDENTIALS',
      lockedUntilIso: fail.lockedUntilIso,
      audits: buildLoginFailureAudits(fresh || row, key, fail),
    };
  }

  clearAccountLock(db, row.id);
  const createdAtISO = nowIso();
  const accessToken = createRawToken();
  const refreshToken = createRawToken();
  const sessionId = mobileSessionId();
  const deviceId = String(deviceMeta.deviceId || '').trim() || `device_${crypto.randomBytes(8).toString('hex')}`;
  const deviceName = String(deviceMeta.deviceName || '').trim();
  const platform = String(deviceMeta.platform || 'android').trim().toLowerCase();

  const accessExpires = addMinutesToIso(createdAtISO, MOBILE_ACCESS_TTL_DAYS * 24 * 60);
  const refreshExpires = addMinutesToIso(createdAtISO, MOBILE_REFRESH_TTL_DAYS * 24 * 60);

  db.transaction(() => {
    db.prepare(
      `INSERT INTO mobile_auth_sessions (
        id, user_id, access_token_hash, refresh_token_hash, device_id, device_name, platform,
        created_at_iso, last_seen_at_iso, access_expires_at_iso, refresh_expires_at_iso, revoked_at_iso
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL)`
    ).run(
      sessionId,
      row.id,
      hashToken(accessToken),
      hashToken(refreshToken),
      deviceId,
      deviceName,
      platform,
      createdAtISO,
      createdAtISO,
      accessExpires,
      refreshExpires
    );
    db.prepare(
      `INSERT INTO mobile_devices (id, user_id, device_id, device_name, platform, fcm_token, registered_at_iso, updated_at_iso)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(user_id, device_id) DO UPDATE SET
         device_name = excluded.device_name,
         platform = excluded.platform,
         updated_at_iso = excluded.updated_at_iso`
    ).run(
      `dev_${crypto.randomBytes(10).toString('hex')}`,
      row.id,
      deviceId,
      deviceName,
      platform,
      null,
      createdAtISO,
      createdAtISO
    );
    db.prepare(`UPDATE app_users SET last_login_at_iso = ? WHERE id = ?`).run(createdAtISO, row.id);
  })();

  const user = enrichUserWithHrSelfService(db, publicUserFromRow({ ...row, last_login_at_iso: createdAtISO }));
  const branchId = defaultBranchIdForDb(db);
  return {
    ok: true,
    accessToken,
    refreshToken,
    expiresAtIso: accessExpires,
    refreshExpiresAtIso: refreshExpires,
    deviceId,
    session: {
      ...buildSessionPayload(user),
      currentBranchId: branchId,
      viewAllBranches: false,
      branches: listBranches(db),
      ...sessionSecurityMeta(accessExpires),
      authKind: 'mobile',
    },
  };
}

export function refreshMobileSession(db, refreshToken) {
  const raw = String(refreshToken || '').trim();
  if (!raw) return { ok: false, code: 'INVALID_REFRESH', error: 'Refresh token required.' };
  const row = findMobileSessionByRefreshHash(db, hashToken(raw));
  if (!row) return { ok: false, code: 'INVALID_REFRESH', error: 'Invalid or expired refresh token.' };
  const now = nowIso();
  if (String(row.refresh_expires_at_iso || '') < now) {
    return { ok: false, code: 'INVALID_REFRESH', error: 'Refresh token expired. Sign in again.' };
  }
  if (row.status !== 'active') {
    return { ok: false, code: 'INVALID_REFRESH', error: 'Account is not active.' };
  }

  const accessToken = createRawToken();
  const newRefreshToken = createRawToken();
  const accessExpires = addMinutesToIso(now, MOBILE_ACCESS_TTL_DAYS * 24 * 60);
  const refreshExpires = addMinutesToIso(now, MOBILE_REFRESH_TTL_DAYS * 24 * 60);

  db.prepare(
    `UPDATE mobile_auth_sessions
     SET access_token_hash = ?, refresh_token_hash = ?, last_seen_at_iso = ?,
         access_expires_at_iso = ?, refresh_expires_at_iso = ?
     WHERE id = ?`
  ).run(
    hashToken(accessToken),
    hashToken(newRefreshToken),
    now,
    accessExpires,
    refreshExpires,
    row.id
  );

  const userRow = userRowFromMobileJoin(row);
  const user = enrichUserWithHrSelfService(db, publicUserFromRow(userRow));
  const branchId = defaultBranchIdForDb(db);
  return {
    ok: true,
    accessToken,
    refreshToken: newRefreshToken,
    expiresAtIso: accessExpires,
    refreshExpiresAtIso: refreshExpires,
    session: {
      ...buildSessionPayload(user),
      currentBranchId: branchId,
      viewAllBranches: false,
      branches: listBranches(db),
      ...sessionSecurityMeta(accessExpires),
      authKind: 'mobile',
    },
  };
}

export function logoutMobileSession(db, mobileSessionId) {
  const id = String(mobileSessionId || '').trim();
  if (!id) return;
  db.prepare(`UPDATE mobile_auth_sessions SET revoked_at_iso = ? WHERE id = ?`).run(nowIso(), id);
}

export function registerMobileDeviceToken(db, userId, { deviceId, fcmToken, deviceName, platform } = {}) {
  const uid = String(userId || '').trim();
  const did = String(deviceId || '').trim();
  const token = String(fcmToken || '').trim();
  if (!uid || !did || !token) {
    return { ok: false, error: 'deviceId and fcmToken are required.' };
  }
  const now = nowIso();
  db.prepare(
    `INSERT INTO mobile_devices (id, user_id, device_id, device_name, platform, fcm_token, registered_at_iso, updated_at_iso)
     VALUES (?,?,?,?,?,?,?,?)
     ON CONFLICT(user_id, device_id) DO UPDATE SET
       fcm_token = excluded.fcm_token,
       device_name = COALESCE(excluded.device_name, mobile_devices.device_name),
       platform = COALESCE(excluded.platform, mobile_devices.platform),
       updated_at_iso = excluded.updated_at_iso`
  ).run(
    `dev_${crypto.randomBytes(10).toString('hex')}`,
    uid,
    did,
    String(deviceName || '').trim(),
    String(platform || 'android').trim(),
    token,
    now,
    now
  );
  return { ok: true };
}
