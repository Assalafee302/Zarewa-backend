/**
 * HTTP idempotency for safe retries (double-submit, flaky networks).
 * Keys are scoped per signed-in user and route name.
 */

const MAX_KEY_LEN = 128;
const MAX_BODY_STORE = 480_000;
const TTL_HOURS = 24;

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
  try {
    db.prepare(
      `DELETE FROM http_idempotency WHERE datetime(created_at_iso) < datetime('now', ?)`
    ).run(`-${TTL_HOURS} hours`);
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
    if (!msg.includes('UNIQUE') && e?.code !== 'SQLITE_CONSTRAINT_PRIMARYKEY') {
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
