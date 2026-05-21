/**
 * Procedural help knowledge for the Zarewa help assistant.
 * Used by server /api/help/chat and mirrored in the frontend for instant offline answers.
 */

/** @typedef {{ label: string; to: string; state?: object }} HelpLink */
/** @typedef {{ id: string; title: string; keywords: string[]; answer: string; steps: string[]; links: HelpLink[] }} HelpArticle */

/** @type {HelpArticle[]} */
export const HELP_ARTICLES = [
  {
    id: 'record-receipt',
    title: 'How to record a payment (receipt)',
    keywords: [
      'receipt',
      'payment',
      'record payment',
      'add receipt',
      'receive money',
      'customer paid',
      'payments tab',
      'rcp',
    ],
    answer:
      'Payments (receipts) are recorded against an approved quotation from the Sales workspace. Each receipt updates what the customer owes and may unlock cutting list or production steps when enough has been collected.',
    steps: [
      'Open Sales from the sidebar.',
      'Go to the Payments tab (sometimes labelled receipts).',
      'Click Record payment (or use the dashboard quick action Record payment).',
      'Select the quotation, enter amount, date, and treasury account(s), then save.',
      'Print or share the receipt reference (RCP-…) if the customer needs proof.',
    ],
    links: [
      { label: 'Sales — Payments', to: '/sales', state: { focusSalesTab: 'receipts' } },
      { label: 'Dashboard quick actions', to: '/' },
    ],
  },
  {
    id: 'receipt-mistake',
    title: 'I made a mistake on a payment',
    keywords: [
      'mistake',
      'wrong amount',
      'wrong receipt',
      'fix payment',
      'edit receipt',
      'correct receipt',
      'posted wrong',
      'error payment',
    ],
    answer:
      'What you can do depends on whether the payment was only saved in Sales or already posted to the customer ledger. Posted ledger receipts are restricted so Finance can keep an audit trail.',
    steps: [
      'If the receipt is still editable in Sales, open it from Payments and fix amount, date, or account before anyone posts it to the ledger.',
      'If you see “Posted payments cannot be changed here”, ask Finance to reverse the ledger entry; then record the correct payment again on the same quotation.',
      'If your role cannot edit at all, ask a branch manager or finance user — or submit an edit approval if the row is locked pending second approval.',
      'For a closed accounting month, you may need the period unlocked in Settings → Governance before any new posting.',
    ],
    links: [
      { label: 'Sales — Payments', to: '/sales', state: { focusSalesTab: 'receipts' } },
      { label: 'Edit approvals', to: '/edit-approvals' },
      { label: 'Settings — governance', to: '/settings/governance' },
      { label: 'Finance', to: '/accounts' },
    ],
  },
  {
    id: 'quotation',
    title: 'How to create a quotation',
    keywords: ['quotation', 'quote', 'new quote', 'create quote', 'pricing', 'qt-'],
    answer: 'Quotations capture what you are selling, pricing, and terms before any payment or production work.',
    steps: [
      'Open Sales → Quotations tab.',
      'Click New quotation (or use the dashboard quick action).',
      'Choose customer, lines, gauges/colours as required, and save.',
      'Track status (draft, sent, approved, etc.) from the same list.',
    ],
    links: [
      { label: 'Sales — Quotations', to: '/sales', state: { focusSalesTab: 'quotations' } },
    ],
  },
  {
    id: 'cutting-list',
    title: 'Cutting list and production readiness',
    keywords: ['cutting list', 'cutting', 'material ready', 'production blocked', 'dispatch'],
    answer:
      'The cutting list ties a quotation to coil/material picks. Operations and stock checks can block edits once production has started or finished.',
    steps: [
      'Open the quotation in Sales and add or open the cutting list.',
      'Ensure enough payment has been collected if your policy requires it (often 50%+ before cutting).',
      'Resolve any material readiness warnings shown on the quote or cutting list modal.',
      'If editing is blocked because production is running, coordinate with Operations before changing lines.',
    ],
    links: [
      { label: 'Sales', to: '/sales' },
      { label: 'Operations', to: '/operations' },
    ],
  },
  {
    id: 'refund',
    title: 'Refunds',
    keywords: ['refund', 'return money', 'customer refund', 'overpay', 'rf-'],
    answer:
      'Refunds go through Sales with eligibility rules tied to quotation balances and approvals. Payout may still sit in Finance until treasury processes it.',
    steps: [
      'Open Sales → Refunds (or the refund action on the quotation/customer).',
      'Start a refund request with reason and amount; the app will show if the quote is eligible.',
      'Route through manager/finance approval if required.',
      'Track payout status in Finance → Payments when treasury disburses.',
    ],
    links: [
      { label: 'Sales', to: '/sales' },
      { label: 'Finance — Payments', to: '/accounts', state: { tab: 'payments' } },
      { label: 'Manager dashboard', to: '/manager' },
    ],
  },
  {
    id: 'period-locked',
    title: 'Accounting period is locked',
    keywords: ['period locked', 'locked period', 'cannot post', 'closed month', 'governance'],
    answer:
      'Finance can lock accounting months so backdated receipts and journals cannot disturb closed books.',
    steps: [
      'Check the receipt or voucher date — it must fall in an open month.',
      'Ask finance to review Settings → Governance if the month should still be open.',
      'Do not bypass locks locally; use your MD/finance escalation path for true backdating.',
    ],
    links: [
      { label: 'Settings — governance', to: '/settings/governance' },
      { label: 'Finance', to: '/accounts' },
    ],
  },
  {
    id: 'edit-approval',
    title: 'Edit approvals (second approval)',
    keywords: ['edit approval', 'second approval', 'locked edit', 'change approved', 'pending edit'],
    answer:
      'Sensitive edits after posting may require a second approver before the change applies.',
    steps: [
      'If you see a second-approval banner on a row, wait for an approver or open Edit approvals from the sidebar.',
      'Approvers review pending changes and approve or reject.',
      'After approval, refresh the Sales or Finance screen and confirm the row updated.',
    ],
    links: [
      { label: 'Edit approvals', to: '/edit-approvals' },
      { label: 'Manager dashboard', to: '/manager' },
    ],
  },
  {
    id: 'procurement-po',
    title: 'Purchase orders and store receipt (GRN)',
    keywords: [
      'purchase order',
      'po',
      'procurement',
      'grn',
      'goods receipt',
      'supplier',
      'in transit',
    ],
    answer:
      'Procurement runs POs from draft through approval, transport, and store GRN. Quantities are often finalized at GRN.',
    steps: [
      'Open Procurement → Purchases to create or approve a PO.',
      'Assign transport and post in transit when material leaves the supplier.',
      'Operations / store completes GRN against the PO when material arrives.',
      'Pay supplier from Procurement → Payments when AP is due.',
    ],
    links: [{ label: 'Procurement', to: '/procurement' }],
  },
  {
    id: 'operations-production',
    title: 'Production and stock',
    keywords: ['production', 'operations', 'stock transfer', 'coil', 'queue', 'grn store'],
    answer:
      'Operations manages stock, coil traceability, production queue, and material exceptions.',
    steps: [
      'Check Operations → Overview for queue and alerts.',
      'Use Stock management for levels, transfers, and adjustments.',
      'Open a coil profile from stock or search when you need traceability.',
      'Material exceptions capture offcuts and non-standard usage.',
    ],
    links: [{ label: 'Operations', to: '/operations' }],
  },
  {
    id: 'finance-recon',
    title: 'Bank reconciliation and treasury',
    keywords: [
      'reconciliation',
      'bank recon',
      'treasury',
      'finance',
      'accounts',
      'settlement',
      'audit',
    ],
    answer:
      'Finance handles treasury balances, matching bank lines to receipts, disbursements, and audit checklists.',
    steps: [
      'Open Finance & accounts from the sidebar.',
      'Use Treasury for account balances; Receipts & recon for matching customer receipts to bank.',
      'Payments tab covers disbursements and refund payouts.',
      'Audit tab lists checklist items finance should clear.',
    ],
    links: [
      { label: 'Finance', to: '/accounts' },
      { label: 'Sales receipts (detail)', to: '/sales', state: { focusSalesTab: 'receipts' } },
    ],
  },
  {
    id: 'search-navigation',
    title: 'Finding a quote, receipt, or refund',
    keywords: ['search', 'find', 'global search', 'qt-', 'rcp-', 'rf-', 'lookup'],
    answer:
      'Use the search box in the top header. Prefixes help: QT- quotations, RCP- receipts, RF- refunds.',
    steps: [
      'Click the header search field or press the shortcut if enabled.',
      'Type the reference or customer name.',
      'Pick the result to jump to Sales on the right tab.',
    ],
    links: [{ label: 'Sales', to: '/sales' }],
  },
  {
    id: 'customer-hold',
    title: 'Payment blocked or customer on hold',
    keywords: ['hold', 'blocked', 'cannot post receipt', 'ledger blocked', 'clearance', 'manager'],
    answer:
      'Manager clearance or compliance holds can pause new receipts until resolved.',
    steps: [
      'Read the exact error on the receipt form — it often names the hold reason.',
      'Open Manager dashboard → Transaction intel or clearance queues.',
      'Clear the hold or finish any open refund before posting cash again.',
    ],
    links: [
      { label: 'Manager dashboard', to: '/manager' },
      { label: 'Sales — customers', to: '/sales', state: { focusSalesTab: 'customers' } },
    ],
  },
  {
    id: 'settings-access',
    title: 'Settings, team access, and guides',
    keywords: ['settings', 'password', 'role', 'permission', 'team', 'guide', 'help'],
    answer:
      'Settings holds profile, team access, governance (period locks), and the department workspace guide.',
    steps: [
      'Open Settings from the sidebar.',
      'Use Team access for users and permissions.',
      'Use Governance for accounting period locks.',
      'Scroll the workspace guide section for department-specific workflows.',
    ],
    links: [{ label: 'Settings', to: '/settings' }],
  },
];

const STOP_WORDS = new Set([
  'a',
  'an',
  'the',
  'and',
  'or',
  'to',
  'for',
  'of',
  'in',
  'on',
  'at',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'being',
  'have',
  'has',
  'had',
  'do',
  'does',
  'did',
  'will',
  'would',
  'could',
  'should',
  'may',
  'might',
  'must',
  'shall',
  'can',
  'i',
  'me',
  'my',
  'we',
  'our',
  'you',
  'your',
  'it',
  'its',
  'this',
  'that',
  'these',
  'those',
  'what',
  'which',
  'who',
  'whom',
  'whose',
  'where',
  'when',
  'why',
  'how',
  'if',
  'then',
  'than',
  'so',
  'as',
  'with',
  'from',
  'by',
  'about',
  'into',
  'through',
  'during',
  'before',
  'after',
  'above',
  'below',
  'between',
  'under',
  'again',
  'further',
  'once',
  'here',
  'there',
  'all',
  'each',
  'few',
  'more',
  'most',
  'other',
  'some',
  'such',
  'no',
  'nor',
  'not',
  'only',
  'own',
  'same',
  'too',
  'very',
  'just',
  'also',
  'now',
  'please',
  'tell',
  'show',
  'need',
  'want',
  'like',
  'get',
  'use',
  'using',
  'zarewa',
  'system',
  'app',
]);

/**
 * @param {string} text
 * @returns {string[]}
 */
export function tokenizeHelpQuery(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
}

/**
 * @param {string} query
 * @returns {{ article: HelpArticle; score: number } | null}
 */
export function matchHelpArticle(query) {
  const q = String(query || '').trim();
  if (!q) return null;
  const tokens = tokenizeHelpQuery(q);
  const qLower = q.toLowerCase();
  let best = null;
  let bestScore = 0;

  for (const article of HELP_ARTICLES) {
    let score = 0;
    const titleLower = article.title.toLowerCase();
    if (titleLower.includes(qLower) || qLower.includes(titleLower.slice(0, 12))) {
      score += 8;
    }
    for (const kw of article.keywords) {
      const k = kw.toLowerCase();
      if (qLower.includes(k)) score += 6;
      else if (tokens.some((t) => k.includes(t) || t.includes(k))) score += 3;
    }
    for (const token of tokens) {
      if (titleLower.includes(token)) score += 2;
      if (article.answer.toLowerCase().includes(token)) score += 1;
      for (const step of article.steps) {
        if (step.toLowerCase().includes(token)) score += 1;
      }
    }
    if (score > bestScore) {
      bestScore = score;
      best = article;
    }
  }

  if (!best || bestScore < 4) return null;
  return { article: best, score: bestScore };
}

/**
 * @param {HelpArticle} article
 * @returns {string}
 */
export function formatHelpArticleReply(article) {
  const lines = [`**${article.title}**`, '', article.answer];
  if (article.steps.length > 0) {
    lines.push('', '**Steps:**');
    article.steps.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
  }
  return lines.join('\n');
}

/**
 * @param {HelpArticle} article
 * @returns {HelpLink[]}
 */
export function helpArticleLinks(article) {
  return Array.isArray(article.links) ? article.links : [];
}

/** Short suggestions shown in the help dock UI. */
export const HELP_QUICK_QUESTIONS = [
  { label: 'Record a payment', query: 'How do I add or record a receipt?' },
  { label: 'I made a mistake', query: 'What should I do if I made a mistake on a payment?' },
  { label: 'Create a quotation', query: 'How do I create a quotation?' },
  { label: 'Cutting list', query: 'How does the cutting list work?' },
  { label: 'Period locked', query: 'Why is the accounting period locked?' },
  { label: 'Find a reference', query: 'How do I search for QT or RCP references?' },
];
