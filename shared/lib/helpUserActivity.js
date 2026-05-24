import { HELP_ARTICLES } from './helpKnowledge.js';

/** Audit actions → help article for coaching from real ERP activity. */
export const TRANSACTION_ACTION_GUIDES = {
  'ledger.receipt': { articleId: 'record-receipt', category: 'payments', label: 'Receipt posting' },
  'receipt.finance_settlement': { articleId: 'finance-receipt-clearance', category: 'payments', label: 'Receipt settlement' },
  'receipt.bank_confirmation': { articleId: 'finance-receipt-clearance', category: 'payments', label: 'Bank confirmation' },
  'receipt.delete': { articleId: 'receipt-mistake', category: 'corrections', label: 'Receipt deletion' },
  'ledger.correct_receipt_split': { articleId: 'receipt-mistake', category: 'corrections', label: 'Receipt correction' },
  'ledger.reverse_receipt': { articleId: 'receipt-mistake', category: 'corrections', label: 'Receipt reversal' },
  'treasury.ledger_receipt_correct': { articleId: 'receipt-mistake', category: 'corrections', label: 'Treasury receipt fix' },
  'refund.create': { articleId: 'refund-headroom-categories', category: 'refunds', label: 'Refund request' },
  'refund.review': { articleId: 'refund-approval-workflow', category: 'refunds', label: 'Refund review' },
  'refund.pay': { articleId: 'refund-approval-workflow', category: 'refunds', label: 'Refund payout' },
  'refund.cancel_before_pay': { articleId: 'refund-approval-workflow', category: 'refunds', label: 'Refund cancel' },
  'ledger.refund_advance': { articleId: 'refund-headroom-categories', category: 'refunds', label: 'Advance refund' },
  'quotation.overpay_auto_reconciled': {
    articleId: 'overpayment-quotation-credit',
    category: 'quotations',
    label: 'Overpayment credit',
  },
  'quotation.delete': { articleId: 'quotation', category: 'quotations', label: 'Quotation delete' },
  'quotation.bm_price_exception_approve': { articleId: 'quotation', category: 'quotations', label: 'Price exception' },
  'payment_request.create': { articleId: 'finance-receipt-clearance', category: 'payments', label: 'Payment request' },
  'period.lock': { articleId: 'period-locked', category: 'errors', label: 'Period lock' },
  'period.unlock': { articleId: 'period-locked', category: 'errors', label: 'Period unlock' },
  'ledger.advance': { articleId: 'record-receipt', category: 'payments', label: 'Customer advance' },
  'ledger.apply_advance': { articleId: 'overpayment-quotation-credit', category: 'payments', label: 'Apply advance' },
};

/** Keywords in audit notes → guide (when user hit an error message). */
export const ERROR_NOTE_GUIDE_HINTS = [
  { pattern: /period\s*lock|locked\s*period|cannot\s*post/i, articleId: 'period-locked', label: 'Period locked' },
  { pattern: /headroom|exceed.*refund|refund.*cap/i, articleId: 'refund-headroom-categories', label: 'Refund headroom' },
  { pattern: /overpay|overpaid|credit/i, articleId: 'overpayment-quotation-credit', label: 'Overpayment' },
  { pattern: /posted.*cannot|cannot.*edit.*receipt|reverse/i, articleId: 'receipt-mistake', label: 'Receipt fix' },
  { pattern: /production.*block|cutting\s*list/i, articleId: 'cutting-list', label: 'Cutting list' },
  { pattern: /grn|goods\s*received/i, articleId: 'procurement-full-workflow', label: 'GRN' },
];

/**
 * @param {string} action
 * @returns {{ articleId: string; category: string; label: string } | null}
 */
export function guideForTransactionAction(action) {
  return TRANSACTION_ACTION_GUIDES[String(action || '').trim()] || null;
}

/**
 * @param {string} note
 * @returns {{ articleId: string; label: string } | null}
 */
export function guideForErrorNote(note) {
  const text = String(note || '');
  if (!text.trim()) return null;
  for (const hint of ERROR_NOTE_GUIDE_HINTS) {
    if (hint.pattern.test(text)) return { articleId: hint.articleId, label: hint.label };
  }
  return null;
}

/**
 * @param {{ totals?: Record<string, number>; recentErrors?: { action?: string; note?: string }[]; performance?: { level?: string } }} profile
 * @returns {{ id: string; title: string; query: string; reason: string; weight: number }[]}
 */
export function buildTransactionCoachingHints(profile) {
  if (!profile || typeof profile !== 'object') return [];
  /** @type {{ id: string; title: string; query: string; reason: string; weight: number }[]} */
  const hints = [];
  const seen = new Set();

  const push = (articleId, reason, weight) => {
    if (!articleId || seen.has(articleId)) return;
    const article = HELP_ARTICLES.find((a) => a.id === articleId);
    if (!article) return;
    seen.add(articleId);
    hints.push({
      id: `txn-${articleId}`,
      title: article.title,
      query: `Help me with: ${article.title}`,
      reason,
      weight,
    });
  };

  for (const err of profile.recentErrors || []) {
    const fromAction = guideForTransactionAction(err.action);
    if (fromAction) {
      push(fromAction.articleId, `Recent issue: ${fromAction.label}`, 12);
      continue;
    }
    const fromNote = guideForErrorNote(err.note);
    if (fromNote) {
      push(fromNote.articleId, `Recent error matched: ${fromNote.label}`, 11);
    }
  }

  const totals = profile.totals || {};
  if (Number(totals.refundsRequested) >= 2) {
    push('refund-approval-workflow', `${totals.refundsRequested} refund(s) you requested recently`, 10);
  }
  if (Number(totals.receiptCorrections) >= 1) {
    push('receipt-mistake', `${totals.receiptCorrections} receipt correction(s) in your activity`, 10);
  }
  if (Number(totals.receiptsPosted) >= 5) {
    push('record-receipt', `${totals.receiptsPosted} receipts posted — quick refresher`, 7);
  }
  if (Number(totals.quotationsTouched) >= 3) {
    push('quote-to-cash-workflow', `${totals.quotationsTouched} quotation-related actions recently`, 8);
  }

  for (const g of profile.suggestedGuides || []) {
    push(g.articleId, g.reason, g.weight || 9);
  }

  return hints.sort((a, b) => b.weight - a.weight).slice(0, 5);
}

/**
 * One-line context for smart replies based on user transaction history.
 * @param {import('./helpKnowledge.js').HelpArticle} article
 * @param {{ totals?: Record<string, number>; recentErrors?: { action?: string; note?: string }[] }} [profile]
 */
export function transactionContextForArticle(article, profile) {
  if (!profile || !article) return null;
  for (const err of profile.recentErrors || []) {
    const map = guideForTransactionAction(err.action);
    if (map?.articleId === article.id) {
      return `This relates to your recent **${map.label}** activity in Zarewa.`;
    }
    const noteMap = guideForErrorNote(err.note);
    if (noteMap?.articleId === article.id) {
      return `This matches a **${noteMap.label}** issue from your recent entries.`;
    }
  }
  const totals = profile.totals || {};
  if (article.id === 'record-receipt' && Number(totals.receiptsPosted) > 0) {
    return `You have posted **${totals.receiptsPosted}** receipt(s) in the last two weeks — same workflow applies here.`;
  }
  if (article.id.startsWith('refund') && Number(totals.refundsRequested) > 0) {
    return `You have **${totals.refundsRequested}** refund request(s) on your record recently.`;
  }
  return null;
}

/**
 * Human-readable activity summary lines for the help dock UI.
 * @param {{ totals?: Record<string, number>; performance?: { level?: string; actionsPerDay?: number }; recentErrors?: unknown[] }} profile
 */
export function buildTransactionActivitySummary(profile) {
  if (!profile?.totals) return [];
  const t = profile.totals;
  const lines = [];
  const parts = [];
  if (Number(t.receiptsPosted) > 0) parts.push(`${t.receiptsPosted} receipt(s)`);
  if (Number(t.refundsRequested) > 0) parts.push(`${t.refundsRequested} refund(s)`);
  if (Number(t.paymentsRecorded) > 0) parts.push(`${t.paymentsRecorded} payment(s)`);
  if (Number(t.quotationsTouched) > 0) parts.push(`${t.quotationsTouched} quotation action(s)`);
  if (parts.length) {
    lines.push(`Your last 14 days: ${parts.join(', ')}.`);
  }
  if (Number(t.receiptCorrections) > 0 || Number(t.auditFailures) > 0) {
    const fixes = Number(t.receiptCorrections) + Number(t.auditFailures);
    lines.push(`${fixes} correction or blocked action(s) — guides below target those workflows.`);
  }
  if (profile.performance?.level === 'high') {
    lines.push('High activity — ask short questions and I will keep answers brief.');
  }
  return lines.slice(0, 2);
}

// Backward compat — audit action → article id map
export const AUDIT_ACTION_ARTICLE_HINTS = Object.fromEntries(
  Object.entries(TRANSACTION_ACTION_GUIDES).map(([action, meta]) => [action, meta.articleId])
);
