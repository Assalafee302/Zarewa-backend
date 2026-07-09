/**
 * Memo automation — draft proposals linked to office_memo_drafts (never auto-submit).
 *
 * @module server/aiAutomationEngine/services/memoAutomationService
 */

import { upsertOfficeMemoDraft } from '../../officeDraftOps.js';
import { runMemoAssist } from '../../../shared/lib/memoAssist.js';
import { PROPOSAL_TYPES, PROPOSAL_SOURCES, AUTOMATION_TYPES } from '../../../shared/lib/aiAutomation/proposalTypes.js';
import { createActionProposal } from './aiActionProposalService.js';
import { logAutomation } from '../utils/automationLogger.js';

/**
 * @param {object} user
 * @param {string} roleKey
 */
function suggestRecipientsByRole(roleKey) {
  const rk = String(roleKey || '').toLowerCase();
  if (rk.includes('branch') || rk === 'branch_manager') {
    return { hint: 'Route to Branch Manager for endorsement', officeKey: 'branch_manager' };
  }
  if (rk.includes('finance') || rk === 'accountant') {
    return { hint: 'Finance desk may need CC for payment memos', officeKey: 'finance' };
  }
  return { hint: 'Default office admin routing', officeKey: 'office_admin' };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} user
 * @param {object} input
 */
export async function createMemoAutomationProposal(db, user, input = {}) {
  const subject = String(input.subject || '').trim();
  const body = String(input.body || '').trim();
  const branchId = input.branchId || user?.branchId || user?.workspaceBranchId || 'BR-KD';

  const assist = runMemoAssist({
    subject,
    body,
    memoType: input.memoType || input.suggestedMemoType,
    action: 'classify',
    guidedFields: input.guidedFields,
  });

  const recipientHint = suggestRecipientsByRole(user?.roleKey);
  const draftBody = body || assist.improvedBody || '';
  const draftSubject =
    subject || assist.suggestedSubject || `Memo: ${assist.memoType || input.suggestedMemoType || 'request'}`;

  const draftResult = upsertOfficeMemoDraft(db, user?.id, {
    id: input.draftId,
    branchId,
    subject: draftSubject,
    body: draftBody,
    smartMemoType: assist.memoType || input.suggestedMemoType || input.memoType || '',
    confidentiality: input.confidentiality || 'internal',
    officeKey: input.officeKey || recipientHint.officeKey,
    payload: {
      aiProposal: true,
      automationType: AUTOMATION_TYPES.MEMO_DRAFT,
      suggestedRecipients: recipientHint,
      filingCategory: assist.filingCategory || input.filingCategory || input.suggestedFilingCategory,
      expenseCategory: assist.expenseCategory,
      nextActions: assist.nextActions,
      structureTips: input.structureTips || [],
    },
  });

  if (!draftResult.ok) {
    return { ok: false, error: draftResult.error || 'Could not save memo draft.' };
  }

  const proposal = createActionProposal(db, {
    type: PROPOSAL_TYPES.MEMO,
    source: input.source || PROPOSAL_SOURCES.UNIFIED,
    userId: user?.id,
    confidence: input.confidence,
    title: `Memo draft: ${draftSubject}`.slice(0, 300),
    description: `AI structured memo (${assist.memoType || 'general'}). ${recipientHint.hint}`,
    linkedEntityType: 'office_memo_draft',
    linkedEntityId: draftResult.draft?.id,
    payload: {
      automationType: AUTOMATION_TYPES.MEMO_DRAFT,
      suggestedAction: 'review_memo_draft',
      draftId: draftResult.draft?.id,
      memoType: assist.memoType,
      filingCategory: assist.filingCategory || input.suggestedFilingCategory,
      recipientHint,
      structure: {
        subject: draftSubject,
        body: draftBody,
        requiredDetails: assist.requiredDetails,
        missingDetails: assist.missingDetails,
      },
      warnings: assist.warnings,
    },
    context: input.context,
  });

  logAutomation('memo_proposal_created', {
    proposalId: proposal.proposal?.proposalId,
    draftId: draftResult.draft?.id,
    memoType: assist.memoType,
  });

  return {
    ok: true,
    created: true,
    draft: draftResult.draft,
    proposal: proposal.proposal,
    aiSuggestionOnly: true,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} user
 * @param {object} input
 */
export async function createFilingAutomationProposal(db, user, input = {}) {
  const filingCategory = input.filingCategory || input.suggestedFilingCategory || 'general';
  const subject = String(input.subject || 'Filing suggestion').trim();

  const proposal = createActionProposal(db, {
    type: PROPOSAL_TYPES.FILING,
    source: input.source || PROPOSAL_SOURCES.UNIFIED,
    userId: user?.id,
    confidence: input.confidence,
    title: `Filing: ${filingCategory}`,
    description: `Suggested filing category for office correspondence.`,
    payload: {
      automationType: AUTOMATION_TYPES.FILING_SUGGESTION,
      suggestedAction: 'apply_filing_category',
      filingCategory,
      subject,
      threadId: input.threadId || null,
    },
    context: input.context,
  });

  logAutomation('filing_proposal_created', {
    proposalId: proposal.proposal?.proposalId,
    filingCategory,
  });

  return { ok: true, created: true, proposal: proposal.proposal, aiSuggestionOnly: true };
}
