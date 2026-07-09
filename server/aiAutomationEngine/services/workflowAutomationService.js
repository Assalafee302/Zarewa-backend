/**
 * Workflow automation — work item suggestions (never auto-decide).
 *
 * @module server/aiAutomationEngine/services/workflowAutomationService
 */

import { PROPOSAL_TYPES, PROPOSAL_SOURCES, AUTOMATION_TYPES } from '../../../shared/lib/aiAutomation/proposalTypes.js';
import { createActionProposal } from './aiActionProposalService.js';
import { logAutomation } from '../utils/automationLogger.js';

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} workItemId
 */
function loadWorkItemBrief(db, workItemId) {
  if (!db || !workItemId) return null;
  try {
    const row = db
      .prepare(
        `SELECT id, reference_no, status, priority, due_at_iso, office_key, title, source_kind, summary
         FROM work_items WHERE id = ?`
      )
      .get(String(workItemId));
    if (!row) return null;
    const now = new Date().toISOString();
    const closed = ['closed', 'archived', 'cancelled'].includes(String(row.status || '').toLowerCase());
    let slaState = 'n/a';
    if (row.due_at_iso && !closed) {
      slaState = row.due_at_iso < now ? 'overdue' : 'pending';
    }
    return { ...row, sla_state: slaState, subject: row.summary || row.title };
  } catch {
    return null;
  }
}

/**
 * @param {object} item
 */
function buildWorkflowSuggestions(item) {
  const suggestions = [];
  let priority = 'normal';
  let escalation = null;
  let slaRisk = 'ok';

  if (!item) {
    return { suggestions: ['Work item not found.'], priority, escalation, slaRisk };
  }

  if (item.sla_state === 'overdue') {
    slaRisk = 'overdue';
    priority = 'high';
    suggestions.push('SLA overdue — consider escalation to branch manager.');
    escalation = 'branch_manager';
  } else if (item.sla_state === 'due_soon') {
    slaRisk = 'due_soon';
    suggestions.push('SLA due soon — prioritize review.');
  }

  if (String(item.status || '').toLowerCase() === 'open') {
    suggestions.push('Suggested action: review and endorse or return with comments.');
  }

  if (item.source_kind === 'office_thread') {
    suggestions.push('Office memo — check filing and endorsement route.');
  }

  return { suggestions, priority, escalation, slaRisk };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} user
 * @param {object} input
 */
export async function createWorkflowAutomationProposal(db, user, input = {}) {
  const workItemId = String(input.workItemId || input.work_item_id || '').trim();
  const item = loadWorkItemBrief(db, workItemId);
  const analysis = buildWorkflowSuggestions(item);

  const proposal = createActionProposal(db, {
    type: PROPOSAL_TYPES.WORKFLOW,
    source: input.source || PROPOSAL_SOURCES.UNIFIED,
    userId: user?.id,
    confidence: input.confidence ?? (item ? 0.6 : 0.3),
    title: item ? `Workflow: ${item.reference_no || workItemId}` : 'Workflow suggestion',
    description: analysis.suggestions.join(' '),
    linkedEntityType: workItemId ? 'work_item' : null,
    linkedEntityId: workItemId || null,
    payload: {
      automationType: AUTOMATION_TYPES.WORKFLOW_SUGGESTION,
      suggestedAction: 'review_work_item',
      workItemId,
      suggestedPriority: analysis.priority,
      suggestedEscalation: analysis.escalation,
      slaRisk: analysis.slaRisk,
      suggestions: analysis.suggestions,
      workItemSnapshot: item
        ? {
            referenceNo: item.reference_no,
            status: item.status,
            slaState: item.sla_state,
            subject: item.subject,
          }
        : null,
    },
    context: input.context,
  });

  logAutomation('workflow_proposal_created', {
    proposalId: proposal.proposal?.proposalId,
    workItemId,
    slaRisk: analysis.slaRisk,
  });

  return {
    ok: true,
    created: true,
    proposal: proposal.proposal,
    suggestions: analysis.suggestions,
    aiSuggestionOnly: true,
  };
}
