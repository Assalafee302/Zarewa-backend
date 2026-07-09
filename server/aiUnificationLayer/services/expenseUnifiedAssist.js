/**
 * Expense categorization enrichment via unified AI layer (suggestion-only).
 *
 * @module server/aiUnificationLayer/services/expenseUnifiedAssist
 */

import { searchKnowledge } from '../../aiKnowledgeCenter/services/knowledgeSearchService.js';
import { KNOWLEDGE_TYPES } from '../../../shared/lib/aiKnowledgeCenter/knowledgeTypes.js';
import { isUnifiedAiEnabled } from '../config/unifiedAiConfig.js';
import { logUnified } from '../utils/unifiedAiLogger.js';
import { UNIFIED_AI_ORIGINS } from '../../../shared/lib/aiUnification/unifiedResponseTypes.js';

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
function detectDuplicateExpenseHint(db, branchId, input) {
  if (!db) return null;
  const amount = Number(input.amountNgn || input.amount);
  const reference = String(input.reference || '').trim().toLowerCase();
  const category = String(input.category || input.suggestedCategory || '').trim().toLowerCase();
  if (!amount && !reference) return null;

  const bid = String(branchId || 'BR-KD').trim();
  const rows = db
    .prepare(
      `SELECT expense_id, amount_ngn, category, reference, date
       FROM expenses
       WHERE branch_id = ?
       ORDER BY rowid DESC
       LIMIT 5`
    )
    .all(bid);

  for (const row of rows) {
    const sameAmount = amount > 0 && Math.abs(Number(row.amount_ngn) - amount) < 0.01;
    const sameRef = reference && String(row.reference || '').trim().toLowerCase() === reference;
    const sameCat = category && String(row.category || '').trim().toLowerCase() === category;
    if (sameAmount && (sameRef || sameCat)) {
      return `Possible duplicate: similar entry (${row.expense_id}) on ${row.date || 'recent date'}.`;
    }
  }
  return null;
}

/**
 * @param {string} text
 */
function suggestCapexVsOperational(text) {
  const lower = String(text || '').toLowerCase();
  if (/(land|building|plant|machinery|furniture|vehicle|capex|capital)/i.test(lower)) {
    return { lane: 'capex', hint: 'Text suggests capital expenditure — verify category lane.' };
  }
  if (/(fuel|rent|maintenance|office supplies|operational)/i.test(lower)) {
    return { lane: 'operational', hint: 'Text suggests operational expenditure.' };
  }
  return null;
}

/**
 * Enrich expense category suggestion (non-destructive).
 *
 * @param {import('better-sqlite3').Database} db
 * @param {object} user
 * @param {object} input
 * @param {object} baseSuggestion — from suggestExpenseCategoryForActor
 */
export async function enrichExpenseSuggest(db, user, input, baseSuggestion) {
  if (!isUnifiedAiEnabled()) return baseSuggestion;

  const text = [input.subject, input.body, input.description, input.reference]
    .filter(Boolean)
    .join('\n');
  const suggestions = [];
  const policyWarnings = [];
  let unifiedAi = {
    enabled: true,
    mode: 'suggest',
    source: 'unified',
  };

  try {
    const dupHint = detectDuplicateExpenseHint(db, user?.branchId || user?.workspaceBranchId, {
      ...input,
      category: baseSuggestion.category || baseSuggestion.suggestedCategory,
    });
    if (dupHint) {
      suggestions.push(dupHint);
      unifiedAi.duplicateHint = dupHint;
    }

    const laneHint = suggestCapexVsOperational(text);
    if (laneHint) {
      suggestions.push(laneHint.hint);
      unifiedAi.categoryLane = laneHint.lane;
    }

    const cat = baseSuggestion.suggestedCategory || baseSuggestion.category;
    if (cat && CAPEX_CATEGORIES.has(cat)) {
      policyWarnings.push('Capital category selected — ensure finance approval and asset tagging.');
    }

    if (db && text.trim()) {
      const kc = await searchKnowledge(db, {
        query: `expense policy ${text.slice(0, 120)}`,
        mode: 'hybrid',
        knowledgeType: KNOWLEDGE_TYPES.TROUBLESHOOTING_EXAMPLE,
        module: 'finance',
        limit: 2,
        status: 'active',
      });
      for (const rec of kc.records || []) {
        if (rec.title) {
          policyWarnings.push(`Policy note: ${rec.title}`);
        }
      }
      if (kc.records?.length) unifiedAi.source = 'knowledge_center';
    }

    if (baseSuggestion.category && laneHint?.lane === 'capex' && !CAPEX_CATEGORIES.has(baseSuggestion.category)) {
      suggestions.push('Consider a capital expenditure category for this description.');
    }

    unifiedAi.suggestions = suggestions;
    unifiedAi.policyWarnings = policyWarnings;

    logUnified('expense_suggest_enriched', {
      moduleOrigin: UNIFIED_AI_ORIGINS.EXPENSE,
      suggestionCount: suggestions.length,
      warningCount: policyWarnings.length,
    });
  } catch (e) {
    logUnified('expense_suggest_enrich_error', { error: String(e?.message || e) });
    return baseSuggestion;
  }

  return {
    ...baseSuggestion,
    unifiedAi,
    unifiedSuggestions: suggestions,
    policyWarnings,
    aiSuggestionOnly: true,
  };
}
