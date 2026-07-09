/**
 * AI Intelligence Router — HTTP controllers.
 *
 * @module server/aiIntelligenceRouter/controllers/aiRouterController
 */

import { routeQuery, getRouterAnalyticsSummary } from '../services/aiRouterService.js';

/**
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function handleRouterQuery(db, req, res) {
  try {
    const body = req.body || {};
    const query = String(body.query || '').trim();
    if (!query) {
      return res.status(400).json({ ok: false, error: 'Query is required.' });
    }

    const userContext = body.userContext && typeof body.userContext === 'object' ? body.userContext : {};
    if (req.user?.roleKey && !userContext.role) userContext.role = req.user.roleKey;

    const result = await routeQuery(db, {
      query,
      userContext,
      userId: req.user?.id,
    });

    if (!result.ok) {
      return res.status(400).json(result);
    }

    return res.json(result);
  } catch (e) {
    console.error('[ai-router] query error', e);
    return res.status(500).json({ ok: false, error: 'AI router query failed.' });
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export function handleRouterAnalytics(db, req, res) {
  try {
    const days = Math.min(90, Math.max(1, Number(req.query?.days) || 30));
    const payload = getRouterAnalyticsSummary(db, days);
    return res.json(payload);
  } catch (e) {
    console.error('[ai-router] analytics error', e);
    return res.status(500).json({ ok: false, error: 'Could not load router analytics.' });
  }
}
