/**
 * AI automation proposal HTTP routes.
 *
 * @module server/aiAutomationEngine/routes/aiProposalRoutes
 */

import { requirePermission } from '../../auth.js';
import { allowRateLimit, skipAuthedRateLimit } from '../../rateLimit.js';
import {
  handleApproveProposal,
  handleCreateProposal,
  handleGetProposal,
  handleListProposals,
  handleRejectProposal,
} from '../controllers/aiProposalController.js';
import { isAutomationEnabled } from '../config/automationConfig.js';

const VIEW_PERMS = ['ai.proposals.view', 'ai.proposals.manage', 'settings.manage', 'audit.view'];
const MANAGE_PERMS = ['ai.proposals.manage', 'settings.manage', 'office.use'];

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
export function registerAiAutomationRoutes(app, db, rateBuckets = new Map()) {
  const viewPerm = requirePermission(VIEW_PERMS);
  const managePerm = requirePermission(MANAGE_PERMS);

  app.get('/api/ai-proposals/status', viewPerm, (_req, res) => {
    res.json({ ok: true, automationEnabled: isAutomationEnabled() });
  });

  app.post(
    '/api/ai-proposals/create',
    managePerm,
    rateLimitAuthedUser(rateBuckets, 'ai-proposals-create', 30, 60_000),
    (req, res) => void handleCreateProposal(db, req, res)
  );

  app.get(
    '/api/ai-proposals',
    viewPerm,
    rateLimitAuthedUser(rateBuckets, 'ai-proposals-list', 60, 60_000),
    (req, res) => handleListProposals(db, req, res)
  );

  app.get(
    '/api/ai-proposals/:id',
    viewPerm,
    (req, res) => handleGetProposal(db, req, res)
  );

  app.post(
    '/api/ai-proposals/:id/approve',
    managePerm,
    rateLimitAuthedUser(rateBuckets, 'ai-proposals-approve', 30, 60_000),
    (req, res) => handleApproveProposal(db, req, res)
  );

  app.post(
    '/api/ai-proposals/:id/reject',
    managePerm,
    rateLimitAuthedUser(rateBuckets, 'ai-proposals-reject', 30, 60_000),
    (req, res) => handleRejectProposal(db, req, res)
  );
}
