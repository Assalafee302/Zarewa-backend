/**
 * Expense automation — classification proposals (never auto-post or auto-pay).
 *
 * @module server/aiAutomationEngine/services/expenseAutomationService
 */

import { suggestExpenseCategoryFromMemoText } from '../../../shared/lib/expenseCategorySuggestions.js';
import { PROPOSAL_TYPES, PROPOSAL_SOURCES, AUTOMATION_TYPES } from '../../../shared/lib/aiAutomation/proposalTypes.js';
import { createActionProposal } from './aiActionProposalService.js';
import { logAutomation } from '../utils/automationLogger.js';

const CAPEX_CATEGORIES = new Set([
  'Land and buildings',
  'Plant and machinery',
  'Furniture & fittings',
  'Motor vehicles',
]);

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} branchId
 * @param {object} input
 */
function detectDuplicateHint(db, branchId, input) {
  if (!db) return null;
  const amount = Number(input.amountNgn || input.amount);
  const reference = String(input.reference || '').trim().toLowerCase();
  const bid = String(branchId || 'BR-KD').trim();
  const rows = db
    .prepare(
      `SELECT expense_id, amount_ngn, category, reference, date
       FROM expenses WHERE branch_id = ? ORDER BY rowid DESC LIMIT 5`
    )
    .all(bid);

  for (const row of rows) {
    const sameAmount = amount > 0 && Math.abs(Number(row.amount_ngn) - amount) < 0.01;
    const sameRef = reference && String(row.reference || '').trim().toLowerCase() === reference;
    if (sameAmount && sameRef) {
      return `Possible duplicate of ${row.expense_id} (${row.date})`;
    }
  }
  return null;
}

/**
 * @param {string} category
 */
function suggestLane(category) {
  if (category && CAPEX_CATEGORIES.has(category)) return 'capex';
  return 'operational';
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} user
 * @param {object} input
 */
export async function createExpenseAutomationProposal(db, user, input = {}) {
  const text = {
    subject: input.subject,
    body: input.body,
    description: input.description,
    reference: input.reference,
  };

  const heuristic = suggestExpenseCategoryFromMemoText(text);
  const category = input.category || input.suggestedCategory || heuristic.category;
  const lane = input.categoryLane || suggestLane(category);
  const duplicateHint = detectDuplicateHint(db, user?.branchId || user?.workspaceBranchId, input);
  const policyWarnings = [];

  if (duplicateHint) policyWarnings.push(duplicateHint);
  if (lane === 'capex') policyWarnings.push('Capital expenditure — finance approval required.');
  if (!category) policyWarnings.push('Category unclear — manual selection required.');

  const proposal = createActionProposal(db, {
    type: PROPOSAL_TYPES.EXPENSE,
    source: input.source || PROPOSAL_SOURCES.UNIFIED,
    userId: user?.id,
    confidence: input.confidence ?? (heuristic.confidence === 'high' ? 0.8 : heuristic.confidence === 'medium' ? 0.55 : 0.35),
    title: category ? `Expense: ${category}` : 'Expense classification proposal',
    description: `Suggested category and lane for expense entry. Payment request must be created manually.`,
    payload: {
      automationType: AUTOMATION_TYPES.EXPENSE_CLASSIFICATION,
      suggestedAction: 'apply_expense_classification',
      category,
      categoryLane: lane,
      reasons: heuristic.reasons,
      duplicateHint,
      policyWarnings,
      prefill: {
        subject: input.subject,
        description: input.description,
        reference: input.reference,
        amountNgn: input.amountNgn || input.amount,
        category,
        categoryLane: lane,
      },
      suggestPaymentRequest: Boolean(category && !duplicateHint),
    },
    context: input.context,
  });

  logAutomation('expense_proposal_created', {
    proposalId: proposal.proposal?.proposalId,
    category,
    lane,
    duplicateHint: Boolean(duplicateHint),
    riskLevel: proposal.proposal?.riskLevel,
  });

  return {
    ok: true,
    created: true,
    proposal: proposal.proposal,
    prefill: proposal.proposal?.payload?.prefill,
    aiSuggestionOnly: true,
  };
}
