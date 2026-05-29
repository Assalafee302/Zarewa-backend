import { ensureHelpArticles } from './helpKnowledge.js';

/** Map recent audit actions to help article ids for proactive coaching. */
export const AUDIT_ACTION_ARTICLE_HINTS = {
  'refund.create': 'refund-headroom-categories',
  'refund.review': 'refund-approval-workflow',
  'refund.cancel_before_pay': 'refund-approval-workflow',
  'payment_request.create': 'finance-receipt-clearance',
  'payment_request.review': 'finance-receipt-clearance',
  'period.lock': 'period-locked',
  'period.unlock': 'period-locked',
  'material_incident.approve_post': 'material-incident-workflow',
  'treasury_account.delete': 'branch-treasury-scope',
  'inter_branch_loan.propose': 'settings-access',
};

/**
 * @param {number} avgReadMs
 * @returns {'fast' | 'normal' | 'deep'}
 */
export function classifyHelpReadingPace(avgReadMs) {
  const ms = Number(avgReadMs) || 0;
  if (ms <= 0) return 'normal';
  if (ms < 8000) return 'fast';
  if (ms > 45000) return 'deep';
  return 'normal';
}

/**
 * @param {{ helpfulRate?: number; followUpRate?: number; pace?: string }} profile
 * @returns {string[]}
 */
export function buildBehaviorCoachingNotes(profile) {
  const notes = [];
  const rate = Number(profile?.helpfulRate);
  if (Number.isFinite(rate) && rate > 0 && rate < 0.45) {
    notes.push('Recent answers were often marked not helpful — try the quick prompts or rephrase with module names (Sales, Finance, PO).');
  }
  if (profile?.pace === 'fast' && Number(profile?.followUpRate) > 0.35) {
    notes.push('You often ask follow-up questions quickly — the assistant will prefer shorter step lists when possible.');
  }
  if (profile?.pace === 'deep') {
    notes.push('You usually read guides thoroughly — expanded workflow articles are shown first for you.');
  }
  return notes.slice(0, 2);
}

/**
 * @param {string} articleId
 * @returns {{ label: string; query: string } | null}
 */
export function promptForArticleId(articleId) {
  const article = ensureHelpArticles().find((a) => a.id === articleId);
  if (!article) return null;
  return {
    label: article.title.length > 36 ? `${article.title.slice(0, 33)}…` : article.title,
    query: `Help me with: ${article.title}`,
  };
}
