/**
 * Zare intent router — workflow, transaction, memo, approval, search, and coaching intents.
 */
import { normalizeHelpQueryText } from './helpTypoTolerance.js';

/** @typedef {string} ZareIntent */

const INTENT_RULES = [
  ['meta_question', /\b(who are you|what are you|what can you do|who is (runa|zare)|what is (runa|zare)|how smart|how intelligent)\b/i],
  ['error_explanation', /\b(error|failed|403|denied|locked|amount required|period locked|clearance_scope)\b/i],
  ['reversal_request', /\b(reverse|reversal|undo|take back|cancel posted)\b/i],
  ['correction_request', /\b(correct|correction|fix mistake|fix wrong|i enter wrong|entered wrong|wrong money|wrong amount)\b/i],
  ['wrong_payment_amount', /\b(wrong (payment )?amount|payment amount wrong|paid wrong amount|incorrect amount)\b/i],
  ['wrong_customer_payment', /\b(wrong customer|wrong client|posted to wrong customer|customer payment wrong)\b/i],
  ['duplicate_receipt', /\b(duplicate receipt|receipt duplicate|double receipt|posted twice|receipt twice)\b/i],
  ['wrong_payment_method', /\b(wrong payment method|wrong account|wrong bank|wrong cash)\b/i],
  ['wrong_branch', /\b(wrong branch|other branch|branch mistake)\b/i],
  ['wrong_vendor_or_supplier', /\b(wrong (vendor|supplier)|paid wrong supplier|wrong payee)\b/i],
  ['wrong_expense_amount', /\b(wrong expense|expense amount wrong)\b/i],
  ['missing_attachment', /\b(missing (proof|attachment|document)|attach wrong|wrong document|no attachment)\b/i],
  ['cannot_approve', /\b(can'?t approve|cannot approve|why can'?t i approve|approval blocked|won'?t let me approve)\b/i],
  ['transaction_stuck', /\b(stuck|pending forever|not showing|payment not showing|not appearing)\b/i],
  ['transaction_problem', /\b(transaction (issue|problem)|receipt (issue|problem)|payment (issue|problem)|mistake on)\b/i],
  ['approval_help', /\b(approve|approval|clearance|who can approve|approval level)\b/i],
  ['memo_category_suggestion', /\b(which category|what category|memo type|classify (this )?memo)\b/i],
  ['expense_category_suggestion', /\b(expense category|which expense)\b/i],
  ['memo_writing_help', /\b(make (this )?(memo )?(professional|formal|shorter)|improve (this )?memo|write (a )?memo|grammar)\b/i],
  ['manager_reply_help', /\b(manager reply|reply to staff|draft reply)\b/i],
  ['conversion_help', /\b(convert to expense|convert to procurement|become expense|become procurement|can this be expense)\b/i],
  ['filing_help', /\b(file(d|ing)?|filing category|unfiled)\b/i],
  ['smart_search', /\b(find|search|show me|look for|where is).*(memo|receipt|payment|expense|quotation|po|refund|work item)/i],
  ['daily_briefing', /\b(what needs my attention|today|pending items|my queue|briefing|what should i do next|what next|what do i do next)\b/i],
  [
    'business_analysis',
    /\b(cash flow|cashflow|forecast|predict|profit|margin|stockout|weeks of cover|inventory analys|sales analys|business analys|business intelligence|reorder|under.?stock|over.?stock|aluminium vs|aluzinc vs|coil cover|cash squeeze|future profit)\b/i,
  ],
  ['branch_summary', /\b(branch (workload|summary|performance)|abuja|lagos branch)\b/i],
  ['next_step_guidance', /\b(what (should i|do i) do next|next step|what now|how do i complete)\b/i],
  ['troubleshooting', /\b(machine spoil|gen no diesel|generator|diesel|fuel request|broken|not working)\b/i],
  ['live_data_question', /\b(how many|count|total|balance|stock level|open pending|list my)\b/i],
  ['hybrid_guide_and_data', /\b(how do i).*(show|count|total|pending)/i],
  ['workflow_help', /\b(how do i|how to|steps|workflow|walk me through|where do i)\b/i],
];

/**
 * @param {string} message
 * @param {Array<{ role?: string; content?: string }>} [history]
 * @param {Record<string, unknown>} [pageContext]
 * @returns {ZareIntent}
 */
export function classifyZareIntent(message, history = [], pageContext = null) {
  const q = normalizeHelpQueryText(String(message || '').trim());
  if (!q) return 'workflow_help';

  if (pageContext?.mode === 'transaction_help') {
    if (pageContext?.issueType) return String(pageContext.issueType);
    return 'transaction_problem';
  }
  if (pageContext?.mode === 'memo_compose') {
    if (/\b(expense|procurement|convert)\b/i.test(q)) return 'conversion_help';
    if (/\b(category|classify|type)\b/i.test(q)) return 'memo_category_suggestion';
    return 'memo_writing_help';
  }
  if (pageContext?.mode === 'approval_help') {
    return 'cannot_approve';
  }

  for (const [intent, re] of INTENT_RULES) {
    if (re.test(q)) return intent;
  }

  const userTurns = (history || []).filter((m) => m?.role === 'user').length;
  if (userTurns >= 1 && /\b(more|continue|and then|also)\b/i.test(q)) return 'next_step_guidance';

  return 'workflow_help';
}

/**
 * Map Zare intent to legacy agent route for existing pipeline.
 * @param {ZareIntent} zareIntent
 * @returns {import('./helpAgentIntent.js').AgentRoute}
 */
export function zareIntentToAgentRoute(zareIntent) {
  const intent = String(zareIntent || '');
  if (intent === 'meta_question') return 'meta';
  if (intent === 'live_data_question') return 'erp_data';
  if (intent === 'hybrid_guide_and_data') return 'hybrid';
  if (intent === 'daily_briefing' || intent === 'branch_summary' || intent === 'business_analysis')
    return 'analytics';
  if (
    [
      'wrong_payment_amount',
      'wrong_customer_payment',
      'duplicate_receipt',
      'wrong_payment_method',
      'wrong_branch',
      'wrong_expense_amount',
      'wrong_vendor_or_supplier',
      'transaction_stuck',
      'transaction_problem',
      'correction_request',
      'reversal_request',
      'missing_attachment',
      'error_explanation',
    ].includes(intent)
  ) {
    return 'troubleshoot';
  }
  if (intent === 'cannot_approve' || intent === 'approval_help') return 'clearance';
  if (intent === 'smart_search') return 'erp_data';
  if (intent === 'next_step_guidance' || intent === 'workflow_help' || intent === 'memo_writing_help') return 'guide';
  return 'guide';
}

/**
 * @param {ZareIntent} intent
 */
export function zareIntentLabel(intent) {
  const labels = {
    workflow_help: 'Workflow guide',
    transaction_problem: 'Transaction help',
    cannot_approve: 'Approval guidance',
    correction_request: 'Correction guidance',
    memo_writing_help: 'Memo assistant',
    smart_search: 'Smart search',
    daily_briefing: 'Daily briefing',
    error_explanation: 'Error explanation',
  };
  return labels[intent] || 'ERP operations';
}
