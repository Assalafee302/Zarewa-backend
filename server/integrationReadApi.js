import crypto from 'node:crypto';
import { appendAuditLog } from './controlOps.js';
import { trialBalanceRows, listGlJournalEntries } from './glOps.js';
import { DEFAULT_BRANCH_ID } from './branches.js';

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

/** Per-key + IP sliding window (read-only integration surface). */
const rateBuckets = new Map();
function integrationRateLimitExceeded(keyId, ip, maxPerWindow = 120, windowMs = 60_000) {
  const k = `${keyId}::${ip || 'na'}`;
  const now = Date.now();
  let b = rateBuckets.get(k);
  if (!b || now - b.windowStart >= windowMs) {
    b = { windowStart: now, count: 0 };
    rateBuckets.set(k, b);
  }
  b.count += 1;
  if (b.count > maxPerWindow) return true;
  if (rateBuckets.size > 50_000) {
    for (const [kk, bb] of rateBuckets) {
      if (now - bb.windowStart > windowMs * 2) rateBuckets.delete(kk);
    }
  }
  return false;
}

/** @param {string} [queryBranchId] */
function resolveIntegrationBranchScope(queryBranchId) {
  const q = String(queryBranchId || '').trim();
  if (q && q.toUpperCase() === 'ALL') return 'ALL';
  if (q && q.startsWith('BR-')) return q;
  return DEFAULT_BRANCH_ID;
}

function logIntegrationRead(db, req, row, routeLabel, branchScope) {
  try {
    appendAuditLog(db, {
      actor: { id: row.created_by_user_id || null, username: row.id, displayName: row.name || 'Integration key' },
      action: 'integration_api.read',
      entityKind: 'integration_api_key',
      entityId: row.id,
      status: 'success',
      details: {
        route: routeLabel,
        ip: String(req.ip || req.socket?.remoteAddress || ''),
        branchScope,
        costCenter: String(req.query.costCenter || '').trim() || null,
        startDate: String(req.query.startDate || '').slice(0, 10) || null,
        endDate: String(req.query.endDate || '').slice(0, 10) || null,
      },
    });
  } catch {
    /* ignore */
  }
}

/**
 * Bearer-token read API for automation (trial balance + journal register).
 * @param {import('express').Express} app
 * @param {import('better-sqlite3').Database} db
 */
export function registerIntegrationReadApi(app, db) {
  const requireIntegrationBearer = (req, res, next) => {
    const h = String(req.headers.authorization || '');
    if (!h.startsWith('Bearer ')) {
      return res.status(401).json({ ok: false, code: 'INTEGRATION_AUTH', error: 'Bearer token required.' });
    }
    const token = h.slice(7).trim();
    if (!token) {
      return res.status(401).json({ ok: false, code: 'INTEGRATION_AUTH', error: 'Bearer token required.' });
    }
    const secretHash = hashToken(token);
    let row;
    try {
      row = db
        .prepare(`SELECT * FROM integration_api_keys WHERE secret_hash = ? AND revoked_at_iso IS NULL`)
        .get(secretHash);
    } catch {
      return res.status(503).json({ ok: false, error: 'Integration keys are not available.' });
    }
    if (!row) {
      return res.status(401).json({ ok: false, code: 'INTEGRATION_AUTH', error: 'Invalid integration key.' });
    }
    const ip = String(req.ip || req.socket?.remoteAddress || '');
    if (integrationRateLimitExceeded(row.id, ip)) {
      return res.status(429).json({ ok: false, code: 'INTEGRATION_RATE_LIMIT', error: 'Too many requests for this key.' });
    }
    const now = new Date().toISOString();
    try {
      db.prepare(`UPDATE integration_api_keys SET last_used_at_iso = ? WHERE id = ?`).run(now, row.id);
    } catch {
      /* ignore */
    }
    req.integrationKeyRow = row;
    next();
  };

  app.get('/api/integration/v1/trial-balance', requireIntegrationBearer, (req, res) => {
    try {
      const startDate = String(req.query.startDate || '').slice(0, 10);
      const endDate = String(req.query.endDate || '').slice(0, 10);
      const costCenter = String(req.query.costCenter || '').trim();
      const branchScope = resolveIntegrationBranchScope(req.query.branchId);
      const r = trialBalanceRows(db, startDate, endDate, { costCenter, branchScope });
      if (!r.ok) return res.status(400).json(r);
      logIntegrationRead(db, req, req.integrationKeyRow, 'GET /api/integration/v1/trial-balance', branchScope);
      return res.json({ ...r, ok: true, branchScope });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load trial balance.' });
    }
  });

  app.get('/api/integration/v1/journals', requireIntegrationBearer, (req, res) => {
    try {
      const startDate = String(req.query.startDate || '').slice(0, 10);
      const endDate = String(req.query.endDate || '').slice(0, 10);
      const branchScope = resolveIntegrationBranchScope(req.query.branchId);
      const r = listGlJournalEntries(db, startDate, endDate, { branchScope });
      if (!r.ok) return res.status(400).json(r);
      logIntegrationRead(db, req, req.integrationKeyRow, 'GET /api/integration/v1/journals', branchScope);
      return res.json({ ...r, ok: true, branchScope });
    } catch (e) {
      console.error(e);
      return res.status(500).json({ ok: false, error: 'Could not load journals.' });
    }
  });
}

export { hashToken };
