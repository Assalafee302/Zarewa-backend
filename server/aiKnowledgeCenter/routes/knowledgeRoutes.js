/**
 * AI Knowledge Center — HTTP routes.
 *
 * @module server/aiKnowledgeCenter/routes/knowledgeRoutes
 */

import { requirePermission } from '../../auth.js';
import { allowRateLimit, skipAuthedRateLimit } from '../../rateLimit.js';
import {
  handleArchiveRecord,
  handleCreateRecord,
  handleGetRecord,
  handleGetStats,
  handleListRecords,
  handleListTypes,
  handleListVersions,
  handleReindex,
  handleSearch,
  handleUpdateRecord,
} from '../controllers/knowledgeController.js';

const VIEW_PERMS = ['ai.knowledge.view', 'settings.manage', 'audit.view'];
const MANAGE_PERMS = ['ai.knowledge.manage', 'settings.manage'];

/**
 * @param {Map<string, { count: number; resetAt: number }>} buckets
 * @param {string} label
 * @param {number} maxEvents
 * @param {number} windowMs
 */
function rateLimitAuthedUser(buckets, label, maxEvents, windowMs) {
  return (req, res, next) => {
    if (skipAuthedRateLimit()) return next();
    const uid = String(req.user?.id || '').trim();
    if (!uid) return next();
    const key = `${label}:${uid}`;
    if (!allowRateLimit(buckets, key, maxEvents, windowMs)) {
      return res.status(429).json({
        ok: false,
        error: 'Too many requests. Try again shortly.',
        code: 'RATE_LIMIT',
      });
    }
    return next();
  };
}

/**
 * Register AI Knowledge Center API routes.
 *
 * @param {import('express').Application} app
 * @param {import('better-sqlite3').Database} db
 * @param {Map<string, object>} [rateBuckets]
 */
export function registerAiKnowledgeCenterRoutes(app, db, rateBuckets = new Map()) {
  const view = requirePermission(VIEW_PERMS);
  const manage = requirePermission(MANAGE_PERMS);

  app.get(
    '/api/ai-knowledge-center/stats',
    view,
    (req, res) => handleGetStats(db, req, res)
  );

  app.get(
    '/api/ai-knowledge-center/types',
    view,
    (req, res) => handleListTypes(db, req, res)
  );

  app.get(
    '/api/ai-knowledge-center/records',
    view,
    (req, res) => handleListRecords(db, req, res)
  );

  app.get(
    '/api/ai-knowledge-center/records/:id',
    view,
    (req, res) => handleGetRecord(db, req, res)
  );

  app.get(
    '/api/ai-knowledge-center/records/:id/versions',
    view,
    (req, res) => handleListVersions(db, req, res)
  );

  app.post(
    '/api/ai-knowledge-center/records',
    manage,
    rateLimitAuthedUser(rateBuckets, 'ai-knowledge-create', 60, 60_000),
    (req, res) => handleCreateRecord(db, req, res)
  );

  app.patch(
    '/api/ai-knowledge-center/records/:id',
    manage,
    rateLimitAuthedUser(rateBuckets, 'ai-knowledge-update', 120, 60_000),
    (req, res) => handleUpdateRecord(db, req, res)
  );

  app.post(
    '/api/ai-knowledge-center/records/:id/archive',
    manage,
    rateLimitAuthedUser(rateBuckets, 'ai-knowledge-archive', 60, 60_000),
    (req, res) => handleArchiveRecord(db, req, res)
  );

  app.post(
    '/api/ai-knowledge-center/search',
    view,
    rateLimitAuthedUser(rateBuckets, 'ai-knowledge-search', 120, 60_000),
    (req, res) => void handleSearch(db, req, res)
  );

  app.post(
    '/api/ai-knowledge-center/reindex',
    manage,
    rateLimitAuthedUser(rateBuckets, 'ai-knowledge-reindex', 10, 300_000),
    (req, res) => void handleReindex(db, req, res)
  );
}
