/**
 * Risk control and execution guards for AI automation proposals.
 *
 * AI can propose. Humans decide. System executes only after approval — and
 * even then, financial/HR/ledger actions are NEVER auto-executed by this layer.
 *
 * @module server/aiAutomationEngine/services/aiSafetyGuardService
 */

import {
  AUTOMATION_TYPES,
  PROPOSAL_TYPES,
  RISK_LEVELS,
  APPROVAL_LEVELS,
} from '../../../shared/lib/aiAutomation/proposalTypes.js';
import { logAutomation } from '../utils/automationLogger.js';

/** Actions that must never be performed automatically by AI automation. */
export const FORBIDDEN_AUTO_ACTIONS = Object.freeze([
  'payment',
  'ledger_post',
  'hr_issue',
  'memo_submit',
  'expense_post',
  'auto_pay',
  'auto_approve',
  'work_item_decision',
]);

/**
 * @param {string} automationType
 * @param {object} [payload]
 * @returns {'low' | 'medium' | 'high'}
 */
export function classifyProposalRisk(automationType, payload = {}) {
  const type = String(automationType || '').toUpperCase();
  const p = payload && typeof payload === 'object' ? payload : {};

  if (type === AUTOMATION_TYPES.HR_LETTER_DRAFT) {
    const kind = String(p.letterKind || p.suggestedLetterKind || '').toLowerCase();
    if (/(dismissal|termination|disciplinary|warning|salary_recovery)/i.test(kind)) {
      return RISK_LEVELS.HIGH;
    }
    return RISK_LEVELS.MEDIUM;
  }

  if (type === AUTOMATION_TYPES.EXPENSE_CLASSIFICATION) {
    if (p.duplicateHint || p.policyWarnings?.length) return RISK_LEVELS.MEDIUM;
    if (/(capex|capital|plant|building)/i.test(JSON.stringify(p))) return RISK_LEVELS.MEDIUM;
    return RISK_LEVELS.LOW;
  }

  if (type === AUTOMATION_TYPES.WORKFLOW_SUGGESTION) {
    if (p.slaRisk === 'overdue' || p.suggestedAction === 'escalate') return RISK_LEVELS.MEDIUM;
    return RISK_LEVELS.LOW;
  }

  if (type === AUTOMATION_TYPES.MEMO_DRAFT || type === AUTOMATION_TYPES.FILING_SUGGESTION) {
    if (String(p.confidentiality || '').toLowerCase() === 'confidential') return RISK_LEVELS.MEDIUM;
    return RISK_LEVELS.LOW;
  }

  return RISK_LEVELS.LOW;
}

/**
 * @param {'low' | 'medium' | 'high'} riskLevel
 * @param {string} proposalType
 */
export function resolveRequiredApprovalLevel(riskLevel, proposalType) {
  if (proposalType === PROPOSAL_TYPES.HR_LETTER || riskLevel === RISK_LEVELS.HIGH) {
    return APPROVAL_LEVELS.HR;
  }
  if (proposalType === PROPOSAL_TYPES.EXPENSE || riskLevel === RISK_LEVELS.MEDIUM) {
    return APPROVAL_LEVELS.FINANCE;
  }
  if (proposalType === PROPOSAL_TYPES.WORKFLOW) {
    return APPROVAL_LEVELS.BRANCH_MANAGER;
  }
  return APPROVAL_LEVELS.SELF;
}

/**
 * @param {object} input
 */
export function validateProposalForCreation(input = {}) {
  const payload = input.payload && typeof input.payload === 'object' ? input.payload : {};
  const suggested = String(payload.suggestedAction || payload.action || '').toLowerCase();

  for (const forbidden of FORBIDDEN_AUTO_ACTIONS) {
    if (suggested.includes(forbidden)) {
      logAutomation('proposal_blocked', { reason: 'forbidden_action', suggestedAction: suggested });
      return { ok: false, error: `Forbidden automated action: ${forbidden}` };
    }
  }

  if (payload.executePayment || payload.autoPost || payload.autoIssue) {
    logAutomation('proposal_blocked', { reason: 'forbidden_execution_flag' });
    return { ok: false, error: 'Proposals cannot request direct execution of financial or HR actions.' };
  }

  return { ok: true };
}

/**
 * Approval records human acceptance only — never triggers ERP execution.
 *
 * @param {object} user
 * @param {object} proposal
 */
export function validateProposalApproval(user, proposal) {
  if (!proposal) return { ok: false, error: 'Proposal not found.' };
  if (proposal.status !== 'pending') {
    return { ok: false, error: `Proposal is already ${proposal.status}.` };
  }
  if (!user?.id) return { ok: false, error: 'Sign in required.' };

  const payload = proposal.payload || {};
  for (const forbidden of FORBIDDEN_AUTO_ACTIONS) {
    const blob = JSON.stringify(payload).toLowerCase();
    if (blob.includes(forbidden) && payload.autoExecute) {
      return { ok: false, error: 'This proposal cannot be approved for automatic execution.' };
    }
  }

  return { ok: true, humanApprovalOnly: true };
}

/**
 * @param {object} user
 * @param {string} requiredLevel
 * @param {(perm: string) => boolean} hasPermission
 */
export function userMayApproveProposal(user, requiredLevel, hasPermission = () => false) {
  if (hasPermission('*') || hasPermission('ai.proposals.manage') || hasPermission('settings.manage')) {
    return true;
  }

  switch (requiredLevel) {
    case APPROVAL_LEVELS.MD:
      return hasPermission('hr.payroll.md_approve') || hasPermission('exec.dashboard.view');
    case APPROVAL_LEVELS.HR:
      return hasPermission('hr.letters.approve') || hasPermission('hr.staff.manage');
    case APPROVAL_LEVELS.FINANCE:
      return hasPermission('finance.approve') || hasPermission('finance.post');
    case APPROVAL_LEVELS.BRANCH_MANAGER:
      return hasPermission('office.use') || hasPermission('work_items.decide');
    case APPROVAL_LEVELS.SELF:
    default:
      return true;
  }
}
