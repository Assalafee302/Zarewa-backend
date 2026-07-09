/**
 * Automation hooks — connect unified AI enrichments to proposal creation.
 *
 * @module server/aiAutomationEngine/bridges/automationHooks.js
 */

import { AUTOMATION_TYPES } from '../../../shared/lib/aiAutomation/proposalTypes.js';
import { isAutomationEnabled } from '../config/automationConfig.js';
import { routeAutomationRequest } from '../services/aiAutomationRouterService.js';

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} user
 * @param {object} body
 * @param {object} enrichedResult
 */
export async function processMemoAutomationHook(db, user, body, enrichedResult) {
  if (!isAutomationEnabled()) return enrichedResult;

  const confidence = Number(enrichedResult?.unifiedAi?.confidence) || Number(enrichedResult?.confidence) || 0;
  if (confidence < 0.35 && !body?.forceProposal) return enrichedResult;

  const automation = await routeAutomationRequest(db, user, {
    automationType: AUTOMATION_TYPES.MEMO_DRAFT,
    confidence: Math.max(confidence, 0.45),
    source: enrichedResult?.unifiedAi?.source || 'unified',
    payload: {
      subject: body?.subject,
      body: body?.body,
      memoType: enrichedResult.memoType || enrichedResult?.unifiedAi?.suggestedMemoType,
      suggestedMemoType: enrichedResult?.unifiedAi?.suggestedMemoType,
      filingCategory: enrichedResult.filingCategory || enrichedResult?.unifiedAi?.suggestedFilingCategory,
      structureTips: enrichedResult?.unifiedAi?.structureTips,
      branchId: body?.branchId,
    },
    context: { module: 'office', action: body?.action },
  });

  if (!automation?.created) return enrichedResult;

  return {
    ...enrichedResult,
    automationProposal: automation.proposal,
    memoDraft: automation.draft,
    aiSuggestionOnly: true,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} user
 * @param {object} input
 * @param {object} enrichedResult
 */
export async function processExpenseAutomationHook(db, user, input, enrichedResult) {
  if (!isAutomationEnabled()) return enrichedResult;

  const confidence =
    enrichedResult?.confidence === 'high' ? 0.8 : enrichedResult?.confidence === 'medium' ? 0.55 : 0.4;

  const automation = await routeAutomationRequest(db, user, {
    automationType: AUTOMATION_TYPES.EXPENSE_CLASSIFICATION,
    confidence,
    source: 'unified',
    payload: {
      ...input,
      category: enrichedResult.category || enrichedResult.suggestedCategory,
      suggestedCategory: enrichedResult.suggestedCategory,
      categoryLane: enrichedResult?.unifiedAi?.categoryLane,
      duplicateHint: enrichedResult?.unifiedAi?.duplicateHint,
      policyWarnings: enrichedResult?.policyWarnings,
    },
    context: { module: 'finance' },
  });

  if (!automation?.created) return enrichedResult;

  return {
    ...enrichedResult,
    automationProposal: automation.proposal,
    expensePrefill: automation.prefill,
    aiSuggestionOnly: true,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} user
 * @param {object} body
 * @param {object} enrichedResult
 */
export async function processHrLetterAutomationHook(db, user, body, enrichedResult) {
  if (!isAutomationEnabled()) return enrichedResult;
  if (!body?.userId && !body?.staffUserId) return enrichedResult;

  const confidence = Number(enrichedResult?.unifiedAi?.confidence) || 0.5;

  const automation = await routeAutomationRequest(db, user, {
    automationType: AUTOMATION_TYPES.HR_LETTER_DRAFT,
    confidence,
    source: enrichedResult?.unifiedAi?.source || 'unified',
    payload: {
      ...body,
      letterKind: enrichedResult.suggestedLetterKind,
      purpose: body.purpose,
      draftText: body.draftText || body.body,
    },
    context: { module: 'hr' },
  });

  if (!automation?.created) return enrichedResult;

  return {
    ...enrichedResult,
    automationProposal: automation.proposal,
    letterDraft: automation.letter,
    aiSuggestionOnly: true,
  };
}
