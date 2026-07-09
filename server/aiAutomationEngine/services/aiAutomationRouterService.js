/**
 * Routes AI suggestions into structured proposals when confidence and safety allow.
 *
 * @module server/aiAutomationEngine/services/aiAutomationRouterService
 */

import { AUTOMATION_TYPES } from '../../../shared/lib/aiAutomation/proposalTypes.js';
import { readAutomationConfig, isAutomationEnabled } from '../config/automationConfig.js';
import { classifyProposalRisk } from './aiSafetyGuardService.js';
import { logAutomation } from '../utils/automationLogger.js';
import { createMemoAutomationProposal } from './memoAutomationService.js';
import { createExpenseAutomationProposal } from './expenseAutomationService.js';
import { createHrLetterAutomationProposal } from './hrLetterAutomationService.js';
import { createWorkflowAutomationProposal } from './workflowAutomationService.js';
import { createFilingAutomationProposal } from './memoAutomationService.js';

/**
 * @param {object} opts
 */
export function shouldCreateProposal(opts = {}) {
  if (!isAutomationEnabled()) return false;

  const cfg = readAutomationConfig();
  const confidence = Number(opts.confidence) || 0;
  const riskLevel = opts.riskLevel || classifyProposalRisk(opts.automationType, opts.payload);

  if (riskLevel === 'high') {
    return confidence >= cfg.highRiskConfidenceThreshold;
  }
  return confidence >= cfg.confidenceThreshold;
}

/**
 * Main automation router — converts eligible AI output into proposals.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} user
 * @param {object} input
 */
export async function routeAutomationRequest(db, user, input = {}) {
  if (!isAutomationEnabled()) {
    return { ok: true, created: false, reason: 'automation_disabled' };
  }

  const automationType = String(input.automationType || '').toUpperCase();
  const confidence = Number(input.confidence) || 0;
  const source = String(input.source || 'unified').toLowerCase();
  const payload = input.payload && typeof input.payload === 'object' ? input.payload : {};
  const context = input.context && typeof input.context === 'object' ? input.context : {};

  const riskLevel = classifyProposalRisk(automationType, payload);

  if (!shouldCreateProposal({ automationType, confidence, riskLevel, payload })) {
    logAutomation('proposal_skipped', {
      automationType,
      confidence,
      riskLevel,
      reason: 'below_threshold',
    });
    return { ok: true, created: false, reason: 'below_threshold', suggestionOnly: true };
  }

  logAutomation('routing_automation', { automationType, confidence, riskLevel, source });

  switch (automationType) {
    case AUTOMATION_TYPES.MEMO_DRAFT:
      return createMemoAutomationProposal(db, user, { ...payload, confidence, source, context });
    case AUTOMATION_TYPES.FILING_SUGGESTION:
      return createFilingAutomationProposal(db, user, { ...payload, confidence, source, context });
    case AUTOMATION_TYPES.EXPENSE_CLASSIFICATION:
      return createExpenseAutomationProposal(db, user, { ...payload, confidence, source, context });
    case AUTOMATION_TYPES.HR_LETTER_DRAFT:
      return createHrLetterAutomationProposal(db, user, { ...payload, confidence, source, context });
    case AUTOMATION_TYPES.WORKFLOW_SUGGESTION:
      return createWorkflowAutomationProposal(db, user, { ...payload, confidence, source, context });
    default:
      return { ok: false, error: `Unsupported automation type: ${automationType}` };
  }
}
