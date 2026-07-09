/**
 * AI action proposal HTTP controllers.
 *
 * @module server/aiAutomationEngine/controllers/aiProposalController
 */

import {
  createActionProposal,
  getActionProposals,
  getActionProposalById,
  approveActionProposal,
  rejectActionProposal,
} from '../services/aiActionProposalService.js';
import { routeAutomationRequest } from '../services/aiAutomationRouterService.js';
import { isAutomationEnabled } from '../config/automationConfig.js';
import { userHasPermission } from '../../auth.js';

/**
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export async function handleCreateProposal(db, req, res) {
  try {
    if (!isAutomationEnabled()) {
      return res.status(403).json({
        ok: false,
        error: 'AI automation is disabled. Set ZARE_AI_AUTOMATION_MODE=true to enable.',
      });
    }

    const body = req.body || {};

    if (body.automationType) {
      const routed = await routeAutomationRequest(db, req.user, {
        automationType: body.automationType,
        confidence: body.confidence,
        source: body.source || 'user',
        payload: body.payload || body,
        context: body.context,
      });
      if (!routed.ok) return res.status(400).json(routed);
      return res.status(routed.created ? 201 : 200).json(routed);
    }

    const result = createActionProposal(db, {
      type: body.type,
      source: body.source || 'user',
      title: body.title,
      description: body.description,
      confidence: body.confidence,
      payload: body.payload || body,
      context: body.context,
      userId: req.user?.id,
      linkedEntityType: body.linkedEntityType,
      linkedEntityId: body.linkedEntityId,
      riskLevel: body.riskLevel,
      requiredApprovalLevel: body.requiredApprovalLevel,
    });

    if (!result.ok) return res.status(400).json(result);
    return res.status(201).json(result);
  } catch (e) {
    console.error('[ai-automation] create error', e);
    return res.status(500).json({ ok: false, error: 'Could not create proposal.' });
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export function handleListProposals(db, req, res) {
  try {
    const q = req.query || {};
    const filter = {
      status: q.status,
      type: q.type,
      createdBy: q.mine === '1' ? req.user?.id : q.createdBy,
      limit: q.limit,
      offset: q.offset,
    };
    const result = getActionProposals(db, filter);
    return res.json({ ...result, automationEnabled: isAutomationEnabled() });
  } catch (e) {
    console.error('[ai-automation] list error', e);
    return res.status(500).json({ ok: false, error: 'Could not list proposals.' });
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export function handleGetProposal(db, req, res) {
  try {
    const result = getActionProposalById(db, req.params.id);
    if (!result.ok) return res.status(404).json(result);
    return res.json(result);
  } catch (e) {
    console.error('[ai-automation] get error', e);
    return res.status(500).json({ ok: false, error: 'Could not load proposal.' });
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export function handleApproveProposal(db, req, res) {
  try {
    const result = approveActionProposal(
      db,
      req.user,
      req.params.id,
      (p) => userHasPermission(req.user, p)
    );
    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  } catch (e) {
    console.error('[ai-automation] approve error', e);
    return res.status(500).json({ ok: false, error: 'Could not approve proposal.' });
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 */
export function handleRejectProposal(db, req, res) {
  try {
    const reason = String(req.body?.reason || '').trim();
    const result = rejectActionProposal(db, req.user, req.params.id, reason);
    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  } catch (e) {
    console.error('[ai-automation] reject error', e);
    return res.status(500).json({ ok: false, error: 'Could not reject proposal.' });
  }
}
