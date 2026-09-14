/**
 * HTTP idempotency for safe retries (double-submit, flaky networks).
 * Keys are scoped per signed-in user and route name.
 */
import crypto from 'node:crypto';

const MAX_KEY_LEN = 128;
const MAX_BODY_STORE = 480_000;
const TTL_HOURS = 24;
const PENDING_STATUS = 102;
const PENDING_CODE = 'IDEMPOTENCY_IN_PROGRESS';
let lastPruneAt = 0;

/**
 * @param {unknown} raw
 * @returns {string} empty if invalid / missing
 */
export function normalizeIdempotencyKey(raw) {
  const s = String(raw ?? '').trim();
  if (!s || s.length > MAX_KEY_LEN) return '';
  if (!/^[A-Za-z0-9_-]+$/.test(s)) return '';
  return s;
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function pruneIdempotency(db) {
  if (Date.now() - lastPruneAt < 60_000) return;
  lastPruneAt = Date.now();
  try {
    const cutoff = new Date(Date.now() - TTL_HOURS * 3600e3).toISOString();
    db.prepare(`DELETE FROM http_idempotency WHERE created_at_iso < ?`).run(cutoff);
  } catch {
    /* table may not exist on very old files until migrate runs */
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} userId
 * @param {string} scope
 * @param {string} key
 * @returns {{ status_code: number, body_json: string } | null}
 */
export function findIdempotentResponse(db, userId, scope, key) {
  if (!key || !userId) return null;
  pruneIdempotency(db);
  try {
    return db
      .prepare(
        `SELECT status_code, body_json FROM http_idempotency
         WHERE user_id = ? AND scope = ? AND idempotency_key = ?`
      )
      .get(String(userId), String(scope), key);
  } catch {
    return null;
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ userId: string; scope: string; key: string; statusCode: number; body: unknown }} opts
 */
export function tryStoreIdempotentResponse(db, opts) {
  const { userId, scope, key, statusCode, body } = opts;
  if (!key || !userId || statusCode < 200 || statusCode >= 300) return;
  pruneIdempotency(db);
  let bodyJson;
  try {
    bodyJson = JSON.stringify(body);
  } catch {
    return;
  }
  if (bodyJson.length > MAX_BODY_STORE) return;
  const iso = new Date().toISOString();
  try {
    db.prepare(
      `INSERT INTO http_idempotency (user_id, scope, idempotency_key, status_code, body_json, created_at_iso)
       VALUES (?,?,?,?,?,?)`
    ).run(String(userId), String(scope), key, statusCode, bodyJson, iso);
  } catch (e) {
    const msg = String(e?.message || e);
    const dup =
      msg.includes('UNIQUE') ||
      e?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
      e?.code === 'ER_DUP_ENTRY';
    if (!dup) {
      throw e;
    }
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {string} scope
 * @returns {boolean} true if response was sent (replay)
 */
export function sendIdempotentReplayIfAny(db, req, res, scope) {
  const key = normalizeIdempotencyKey(req.get('Idempotency-Key') || req.get('idempotency-key'));
  const userId = String(req.user?.id || '').trim();
  if (!key || !userId) return false;
  const hit = findIdempotentResponse(db, userId, scope, key);
  if (!hit) return false;
  if (Number(hit.status_code) === PENDING_STATUS) {
    res.status(409).json({
      ok: false,
      code: PENDING_CODE,
      error: 'This save is still being checked. Please wait; do not submit it again.',
      retryAfterMs: 750,
    });
    return true;
  }
  try {
    const parsed = JSON.parse(hit.body_json);
    res.status(hit.status_code).json(parsed);
  } catch {
    res.status(hit.status_code).type('json').send(hit.body_json);
  }
  return true;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req
 * @param {string} scope
 * @param {number} statusCode
 * @param {unknown} body
 */
export function storeIdempotentSuccess(db, req, scope, statusCode, body) {
  const key = normalizeIdempotencyKey(req.get('Idempotency-Key') || req.get('idempotency-key'));
  const userId = String(req.user?.id || '').trim();
  if (!key || !userId) return;
  tryStoreIdempotentResponse(db, { userId, scope, key, statusCode, body });
}

/**
 * Wrap an async route handler with idempotency replay + success storage.
 * @param {import('better-sqlite3').Database} db
 * @param {string} scope
 * @param {(req: import('express').Request, res: import('express').Response) => Promise<void>|void} handler
 * @returns {(req: import('express').Request, res: import('express').Response) => Promise<void>}
 */
export function wrapIdempotentRoute(db, scope, handler) {
  return async (req, res) => {
    if (sendIdempotentReplayIfAny(db, req, res, scope)) return;
    const originalJson = res.json.bind(res);
    /** @type {{ statusCode: number; body: unknown } | null} */
    let captured = null;
    res.json = (body) => {
      captured = { statusCode: res.statusCode || 200, body };
      return originalJson(body);
    };
    await handler(req, res);
    if (captured && captured.statusCode >= 200 && captured.statusCode < 300) {
      storeIdempotentSuccess(db, req, scope, captured.statusCode, captured.body);
    }
  };
}

function duplicateConstraint(error) {
  const message = String(error?.message || error);
  return (
    message.includes('UNIQUE') ||
    error?.code === 'SQLITE_CONSTRAINT_PRIMARYKEY' ||
    error?.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
    error?.code === 'ER_DUP_ENTRY'
  );
}

function requestFingerprint(req) {
  const content = JSON.stringify({
    method: String(req.method || '').toUpperCase(),
    path: String(req.originalUrl || req.url || ''),
    body: req.body ?? null,
  });
  return crypto.createHash('sha256').update(content).digest('base64url');
}

function pendingBodyJson(requestHash) {
  return JSON.stringify({ pending: true, requestHash });
}

/**
 * Claim an operation before its handler runs. The primary key makes two concurrent
 * requests with the same operation ID mutually exclusive.
 */
function claimIdempotentOperation(db, { userId, scope, key, requestHash }) {
  pruneIdempotency(db);
  try {
    db.prepare(
      `INSERT INTO http_idempotency (user_id, scope, idempotency_key, status_code, body_json, created_at_iso)
       VALUES (?,?,?,?,?,?)`
    ).run(userId, scope, key, PENDING_STATUS, pendingBodyJson(requestHash), new Date().toISOString());
    return { claimed: true };
  } catch (error) {
    if (!duplicateConstraint(error)) throw error;
    const hit = findIdempotentResponse(db, userId, scope, key);
    if (!hit) return { claimed: false, pending: true };
    if (Number(hit.status_code) === PENDING_STATUS) {
      let storedHash = '';
      try {
        storedHash = String(JSON.parse(hit.body_json)?.requestHash || '');
      } catch {
        // Treat an unreadable claim as pending; never risk running it twice.
      }
      return {
        claimed: false,
        pending: true,
        payloadMismatch: Boolean(storedHash && storedHash !== requestHash),
      };
    }
    return { claimed: false, replay: hit };
  }
}

function completeIdempotentOperation(db, { userId, scope, key, statusCode, body }) {
  let bodyJson;
  try {
    bodyJson = JSON.stringify(body);
  } catch {
    return false;
  }
  if (bodyJson.length > MAX_BODY_STORE) return false;
  db.prepare(
    `UPDATE http_idempotency
     SET status_code = ?, body_json = ?
     WHERE user_id = ? AND scope = ? AND idempotency_key = ? AND status_code = ?`
  ).run(statusCode, bodyJson, userId, scope, key, PENDING_STATUS);
  return true;
}

function releaseIdempotentOperation(db, { userId, scope, key }) {
  try {
    db.prepare(
      `DELETE FROM http_idempotency
       WHERE user_id = ? AND scope = ? AND idempotency_key = ? AND status_code = ?`
    ).run(userId, scope, key, PENDING_STATUS);
  } catch {
    // A failed request is already returning; cleanup must not replace its response.
  }
}

/**
 * Global safety net for authenticated JSON mutations. Route-specific duplicate business
 * checks remain useful; this layer closes the concurrent-request race before they run.
 */
export function idempotencyMiddleware(db) {
  return (req, res, next) => {
    const method = String(req.method || '').toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return next();
    const key = normalizeIdempotencyKey(req.get('Idempotency-Key') || req.get('idempotency-key'));
    const userId = String(req.user?.id || '').trim();
    if (!key || !userId) return next();

    const scope = `${method} ${String(req.originalUrl || req.url || '')}`;
    const claim = claimIdempotentOperation(db, {
      userId,
      scope,
      key,
      requestHash: requestFingerprint(req),
    });
    if (claim.payloadMismatch) {
      return res.status(409).json({
        ok: false,
        code: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
        error: 'This operation ID was already used for a different request.',
      });
    }
    if (claim.pending) {
      return res.status(409).json({
        ok: false,
        code: PENDING_CODE,
        error: 'This save is still being checked. Please wait; do not submit it again.',
        retryAfterMs: 750,
      });
    }
    if (claim.replay) {
      try {
        return res.status(claim.replay.status_code).json(JSON.parse(claim.replay.body_json));
      } catch {
        return res.status(claim.replay.status_code).type('json').send(claim.replay.body_json);
      }
    }

    const sendJson = res.json.bind(res);
    res.json = (body) => {
      const statusCode = res.statusCode || 200;
      if (statusCode >= 200 && statusCode < 300) {
        const completed = completeIdempotentOperation(db, {
          userId,
          scope,
          key,
          statusCode,
          body,
        });
        if (!completed) releaseIdempotentOperation(db, { userId, scope, key });
      } else {
        releaseIdempotentOperation(db, { userId, scope, key });
      }
      return sendJson(body);
    };
    return next();
  };
}
