/**
 * Unified AI gateway HTTP routes.
 *
 * @module server/aiUnificationLayer/routes/unifiedAiRoutes
 */

import { requireAuth } from '../../auth.js';
import { allowRateLimit, skipAuthedRateLimit } from '../../rateLimit.js';
import {
  formatUnifiedQueryHttpResponse,
  isUnifiedAiEnabled,
  unifiedQuery,
} from '../services/aiOrchestratorService.js';
import { enrichHrLetterAssist } from '../services/hrLetterUnifiedAssist.js';

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
export function registerUnifiedAiRoutes(app, db, rateBuckets = new Map()) {
  app.post(
    '/api/ai/query',
    requireAuth,
    rateLimitAuthedUser(rateBuckets, 'ai-unified-query', 40, 60_000),
    async (req, res) => {
      try {
        const body = req.body || {};
        const query = String(body.query || body.message || '').trim();
        const source = String(body.source || 'ui').trim().toLowerCase();
        const context =
          body.context && typeof body.context === 'object'
            ? body.context
            : body.pageContext && typeof body.pageContext === 'object'
              ? body.pageContext
              : {};

        if (!query) {
          return res.status(400).json({ ok: false, error: 'query is required.' });
        }

        if (source === 'letter') {
          const letterAssist = await enrichHrLetterAssist(db, req.user, body);
          return res.json({
            ok: true,
            source: 'fallback',
            mode: 'suggest',
            answer: letterAssist.unifiedSuggestions?.join('\n') || '',
            suggestions: letterAssist.unifiedSuggestions,
            metadata: {
              moduleOrigin: 'letter',
              fallbackUsed: !isUnifiedAiEnabled(),
              letterAssist,
            },
          });
        }

        const result = await unifiedQuery(db, {
          query,
          source,
          mode: body.mode,
          context: {
            ...context,
            role: req.user?.roleKey,
            user: req.user,
            pathname: context.pathname || body.pathname,
          },
          userId: req.user?.id,
        });

        return res.json(formatUnifiedQueryHttpResponse(result));
      } catch (e) {
        console.error('[ai-unified] gateway error', e);
        return res.status(502).json({ ok: false, error: 'Unified AI query failed.' });
      }
    }
  );

  app.get('/api/ai/unified/status', requireAuth, (_req, res) => {
    res.json({
      ok: true,
      unifiedMode: isUnifiedAiEnabled(),
      gateway: '/api/ai/query',
    });
  });
}
