/**
 * HR letter automation — draft proposals linked to hr_employment_letters (never auto-issue).
 *
 * @module server/aiAutomationEngine/services/hrLetterAutomationService
 */

import { createDraftLetter } from '../../hrLetterWorkflowOps.js';
import { suggestHrLetterAssist } from '../../aiUnificationLayer/services/hrLetterUnifiedAssist.js';
import { PROPOSAL_TYPES, PROPOSAL_SOURCES, AUTOMATION_TYPES } from '../../../shared/lib/aiAutomation/proposalTypes.js';
import { createActionProposal } from './aiActionProposalService.js';
import { logAutomation } from '../utils/automationLogger.js';

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} user
 * @param {object} input
 */
export async function createHrLetterAutomationProposal(db, user, input = {}) {
  const assist = await suggestHrLetterAssist(db, user, input);
  const letterKind = input.letterKind || assist.suggestedLetterKind || 'employment';
  const staffUserId = String(input.userId || input.staffUserId || '').trim();

  if (!staffUserId) {
    return {
      ok: true,
      created: false,
      reason: 'staff_user_id_required',
      suggestions: assist.unifiedSuggestions,
      aiSuggestionOnly: true,
    };
  }

  const draftResult = createDraftLetter(db, user, {
    userId: staffUserId,
    letterKind,
    extraData: {
      ...input.extra,
      purpose: input.purpose,
      draftText: input.draftText || input.body,
      aiGenerated: true,
      suggestedTone: assist.suggestedTone,
    },
    sourceRecordKind: 'ai_proposal',
    sourceRecordId: null,
  });

  if (!draftResult.ok) {
    return { ok: false, error: draftResult.error || 'Could not create HR letter draft.' };
  }

  const letterId = draftResult.id;

  const proposal = createActionProposal(db, {
    type: PROPOSAL_TYPES.HR_LETTER,
    source: input.source || PROPOSAL_SOURCES.UNIFIED,
    userId: user?.id,
    confidence: input.confidence ?? assist.unifiedAi?.confidence ?? 0.5,
    title: `HR letter: ${letterKind.replace(/_/g, ' ')}`,
    description: `Draft letter with ${assist.suggestedTone || 'formal'} tone. Submit via HR approval workflow.`,
    linkedEntityType: 'hr_employment_letter',
    linkedEntityId: letterId,
    payload: {
      automationType: AUTOMATION_TYPES.HR_LETTER_DRAFT,
      suggestedAction: 'review_hr_letter_draft',
      letterKind,
      suggestedTone: assist.suggestedTone,
      suggestedTemplate: assist.suggestedTemplate,
      grammarTips: assist.grammarTips,
      structureTips: assist.structureTips,
      staffUserId,
      letterId,
    },
    context: input.context,
  });

  logAutomation('hr_letter_proposal_created', {
    proposalId: proposal.proposal?.proposalId,
    letterId,
    letterKind,
    tone: assist.suggestedTone,
  });

  return {
    ok: true,
    created: true,
    letter: { id: letterId, draftId: draftResult.draftId, status: draftResult.status },
    proposal: proposal.proposal,
    aiSuggestionOnly: true,
  };
}
