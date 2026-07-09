/**
 * Core AI action proposal service — creates and manages proposal lifecycle.
 *
 * @module server/aiAutomationEngine/services/aiActionProposalService
 */

import { appendAuditLog } from '../../controlOps.js';
import {
  PROPOSAL_STATUSES,
  PROPOSAL_SOURCES,
} from '../../../shared/lib/aiAutomation/proposalTypes.js';
import {
  insertProposal,
  getProposalById,
  listProposals,
  updateProposal,
  proposalsTableReady,
  newProposalId,
} from '../repository/proposalRepository.js';
import {
  classifyProposalRisk,
  resolveRequiredApprovalLevel,
  validateProposalForCreation,
  validateProposalApproval,
  userMayApproveProposal,
} from './aiSafetyGuardService.js';
import { logAutomation } from '../utils/automationLogger.js';

/**
 * Create a structured AI action proposal (never executes ERP actions).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} input
 * @param {string} input.type — memo | expense | hr_letter | workflow | filing
 * @param {string} input.source — router | help | user | unified
 * @param {object} input.payload
 * @param {object} [input.context]
 * @param {string} [input.userId]
 */
export function createActionProposal(db, input = {}) {
  if (!proposalsTableReady(db)) {
    return { ok: false, error: 'AI proposals are not available.' };
  }

  const type = String(input.type || '').trim().toLowerCase();
  const source = String(input.source || PROPOSAL_SOURCES.USER).trim().toLowerCase();
  const payload = input.payload && typeof input.payload === 'object' ? input.payload : {};
  const context = input.context && typeof input.context === 'object' ? input.context : {};

  const guard = validateProposalForCreation({ type, payload });
  if (!guard.ok) return guard;

  const automationType = String(payload.automationType || context.automationType || '').toUpperCase();
  const riskLevel = input.riskLevel || classifyProposalRisk(automationType, payload);
  const confidence = Number(input.confidence ?? payload.confidence ?? context.confidence) || null;
  const requiredApprovalLevel =
    input.requiredApprovalLevel || resolveRequiredApprovalLevel(riskLevel, type);

  const title = String(
    input.title || payload.title || `AI ${type} proposal`
  ).slice(0, 300);
  const description = String(
    input.description || payload.description || payload.summary || ''
  ).slice(0, 4000);

  const fullPayload = {
    ...payload,
    suggestedAction: payload.suggestedAction || describeSuggestedAction(type, payload),
    context,
    automationType: automationType || null,
  };

  const row = insertProposal(db, {
    id: newProposalId(),
    type,
    source,
    title,
    description,
    payload: fullPayload,
    confidence_score: confidence,
    risk_level: riskLevel,
    required_approval_level: requiredApprovalLevel,
    status: PROPOSAL_STATUSES.PENDING,
    linked_entity_type: input.linkedEntityType || payload.linkedEntityType || null,
    linked_entity_id: input.linkedEntityId || payload.linkedEntityId || null,
    created_by: input.userId || context.userId || null,
  });

  logAutomation('proposal_created', {
    proposalId: row.proposalId,
    type,
    source,
    riskLevel,
    confidence,
    requiredApprovalLevel,
    linkedEntityType: row.linkedEntity?.type,
    linkedEntityId: row.linkedEntity?.id,
  });

  if (db && input.userId) {
    try {
      appendAuditLog(db, {
        actor: { id: input.userId },
        action: 'ai.proposal.create',
        entityKind: 'ai_action_proposal',
        entityId: row.proposalId,
        note: title,
        details: { type, source, riskLevel, confidence },
      });
    } catch {
      /* non-fatal */
    }
  }

  return { ok: true, proposal: formatProposalOutput(row) };
}

/**
 * @param {string} type
 * @param {object} payload
 */
function describeSuggestedAction(type, payload) {
  switch (type) {
    case 'memo':
      return 'Review and submit memo draft';
    case 'expense':
      return 'Apply suggested category and create payment request manually';
    case 'hr_letter':
      return 'Review HR letter draft and submit for approval workflow';
    case 'workflow':
      return 'Review suggested work item action';
    case 'filing':
      return 'Apply suggested filing category';
    default:
      return 'Review AI proposal';
  }
}

/**
 * @param {object} row
 */
function formatProposalOutput(row) {
  return {
    proposalId: row.proposalId,
    type: row.type,
    title: row.title,
    description: row.description,
    suggestedAction: row.suggestedAction,
    confidence: row.confidence,
    riskLevel: row.riskLevel,
    requiredApprovalLevel: row.requiredApprovalLevel,
    linkedEntity: row.linkedEntity,
    status: row.status,
    createdAt: row.createdAt,
    payload: row.payload,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} filter
 */
export function getActionProposals(db, filter = {}) {
  if (!proposalsTableReady(db)) return { ok: true, proposals: [] };
  const proposals = listProposals(db, filter).map(formatProposalOutput);
  return { ok: true, proposals };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} id
 */
export function getActionProposalById(db, id) {
  if (!proposalsTableReady(db)) return { ok: false, error: 'AI proposals are not available.' };
  const row = getProposalById(db, id);
  if (!row) return { ok: false, error: 'Proposal not found.' };
  return { ok: true, proposal: formatProposalOutput(row) };
}

/**
 * Approve proposal — records human decision only; does NOT execute ERP actions.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} user
 * @param {string} proposalId
 * @param {(perm: string) => boolean} hasPermission
 */
export function approveActionProposal(db, user, proposalId, hasPermission = () => false) {
  const existing = getProposalById(db, proposalId);
  if (!existing) return { ok: false, error: 'Proposal not found.' };

  const approvalGuard = validateProposalApproval(user, existing);
  if (!approvalGuard.ok) return approvalGuard;

  if (!userMayApproveProposal(user, existing.requiredApprovalLevel, hasPermission)) {
    return { ok: false, error: 'You do not have permission to approve this proposal.' };
  }

  const now = new Date().toISOString();
  const updated = updateProposal(db, proposalId, {
    status: PROPOSAL_STATUSES.APPROVED,
    approved_by: user.id,
    approved_at_iso: now,
  });

  logAutomation('proposal_approved', {
    proposalId,
    approvedBy: user.id,
    type: updated.type,
    riskLevel: updated.riskLevel,
    linkedEntityType: updated.linkedEntity?.type,
    linkedEntityId: updated.linkedEntity?.id,
  });

  try {
    appendAuditLog(db, {
      actor: user,
      action: 'ai.proposal.approve',
      entityKind: 'ai_action_proposal',
      entityId: proposalId,
      note: updated.title,
      details: { type: updated.type, humanApprovalOnly: true },
    });
  } catch {
    /* non-fatal */
  }

  return {
    ok: true,
    proposal: formatProposalOutput(updated),
    message: 'Proposal approved. Complete the action manually in the ERP workflow.',
    humanApprovalOnly: true,
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} user
 * @param {string} proposalId
 * @param {string} [reason]
 */
export function rejectActionProposal(db, user, proposalId, reason = '') {
  const existing = getProposalById(db, proposalId);
  if (!existing) return { ok: false, error: 'Proposal not found.' };
  if (existing.status !== PROPOSAL_STATUSES.PENDING) {
    return { ok: false, error: `Proposal is already ${existing.status}.` };
  }

  const now = new Date().toISOString();
  const updated = updateProposal(db, proposalId, {
    status: PROPOSAL_STATUSES.REJECTED,
    rejected_by: user?.id || null,
    rejected_at_iso: now,
    rejection_reason: String(reason || '').slice(0, 1000) || null,
  });

  logAutomation('proposal_rejected', {
    proposalId,
    rejectedBy: user?.id,
    reason: reason || null,
  });

  try {
    appendAuditLog(db, {
      actor: user,
      action: 'ai.proposal.reject',
      entityKind: 'ai_action_proposal',
      entityId: proposalId,
      note: reason || 'rejected',
      details: { type: existing.type },
    });
  } catch {
    /* non-fatal */
  }

  return { ok: true, proposal: formatProposalOutput(updated) };
}
