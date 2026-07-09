/**
 * AI Intelligence Router — HTTP routes.
 *
 * @module server/aiIntelligenceRouter/routes/aiRouterRoutes
 */

import { requirePermission } from '../../auth.js';
import { allowRateLimit, skipAuthedRateLimit } from '../../rateLimit.js';
import { handleRouterAnalytics, handleRouterQuery } from '../controllers/aiRouterController.js';

const QUERY_PERMS = ['ai.query.access', 'ai.knowledge.view', 'settings.manage', 'audit.view'];
const ANALYTICS_PERMS = ['ai.query.access', 'ai.knowledge.view', 'settings.manage', 'audit.view'];

/**
 * @param {Map<string, { count: number; resetAt: number }>} buckets
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
 * @param {import('express').Application} app
 * @param {import('better-sqlite3').Database} db
 * @param {Map<string, object>} [rateBuckets]
 */
export function registerAiIntelligenceRouterRoutes(app, db, rateBuckets = new Map()) {
  const queryPerm = requirePermission(QUERY_PERMS);
  const analyticsPerm = requirePermission(ANALYTICS_PERMS);

  app.post(
    '/api/ai-router/query',
    queryPerm,
    rateLimitAuthedUser(rateBuckets, 'ai-router-query', 60, 60_000),
    (req, res) => void handleRouterQuery(db, req, res)
  );

  app.get(
    '/api/ai-router/analytics',
    analyticsPerm,
    (req, res) => handleRouterAnalytics(db, req, res)
  );
}
