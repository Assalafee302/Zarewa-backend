/**
 * AI action proposal types and constants.
 *
 * @module shared/lib/aiAutomation/proposalTypes
 */

export const PROPOSAL_TYPES = Object.freeze({
  MEMO: 'memo',
  EXPENSE: 'expense',
  HR_LETTER: 'hr_letter',
  WORKFLOW: 'workflow',
  FILING: 'filing',
});

export const AUTOMATION_TYPES = Object.freeze({
  MEMO_DRAFT: 'MEMO_DRAFT',
  EXPENSE_CLASSIFICATION: 'EXPENSE_CLASSIFICATION',
  HR_LETTER_DRAFT: 'HR_LETTER_DRAFT',
  WORKFLOW_SUGGESTION: 'WORKFLOW_SUGGESTION',
  FILING_SUGGESTION: 'FILING_SUGGESTION',
});

export const PROPOSAL_STATUSES = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  EXECUTED: 'executed',
  EXPIRED: 'expired',
});

export const PROPOSAL_SOURCES = Object.freeze({
  ROUTER: 'router',
  HELP: 'help',
  USER: 'user',
  UNIFIED: 'unified',
});

export const RISK_LEVELS = Object.freeze({
  LOW: 'low',
  MEDIUM: 'medium',
  HIGH: 'high',
});

export const APPROVAL_LEVELS = Object.freeze({
  SELF: 'self',
  BRANCH_MANAGER: 'branch_manager',
  FINANCE: 'finance',
  HR: 'hr',
  MD: 'md',
});

/** @param {string} status */
export function isTerminalProposalStatus(status) {
  return ['approved', 'rejected', 'executed', 'expired'].includes(String(status || ''));
}
