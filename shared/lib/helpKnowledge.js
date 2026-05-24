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
  {
    id: 'quote-to-cash-workflow',
    title: 'End-to-end: quotation to cash and delivery',
    keywords: [
      'quote to cash',
      'full sales process',
      'end to end sales',
      'quotation to delivery',
      'sales workflow',
      'from quote',
      'customer order process',
      'quote payment production',
    ],
    answer:
      'The standard Zarewa sales path runs quotation → approval/collection → cutting list → production → delivery. Payment thresholds and manager holds can pause steps mid-way.',
    steps: [
      'Create and send the quotation in Sales → Quotations; move it to approved when the customer confirms.',
      'Record receipts in Sales → Payments until the quote meets your branch payment policy (often 50%+ before cutting).',
      'Build the cutting list on the quotation; resolve material readiness warnings before Operations picks it up.',
      'Operations runs production from the queue; track job status and coil traceability if questions arise.',
      'Create delivery / dispatch when goods are ready; Finance may reconcile bank lines against receipts already posted.',
      'If anything was posted wrong, stop and use the receipt-mistake path before continuing downstream steps.',
    ],
    links: [
      { label: 'Sales — Quotations', to: '/sales', state: { focusSalesTab: 'quotations' } },
      { label: 'Sales — Payments', to: '/sales', state: { focusSalesTab: 'receipts' } },
      { label: 'Operations', to: '/operations' },
      { label: 'Finance', to: '/accounts' },
    ],
  },
  {
    id: 'procurement-full-workflow',
    title: 'End-to-end: purchase order to supplier payment',
    keywords: [
      'full procurement',
      'po workflow',
      'buying process',
      'supplier payment process',
      'procure to pay',
      'order to grn to payment',
      'transport and grn',
    ],
    answer:
      'Procurement spans PO creation, approval, transport/in-transit, store GRN, and accounts-payable settlement. Quantities and costs are often finalized at GRN.',
    steps: [
      'Create a draft PO in Procurement → Purchases with supplier, lines, and expected quantities.',
      'Route the PO through approval if your branch requires it; watch for transport fee lines that Finance may post separately.',
      'Mark material in transit when it leaves the supplier; Operations sees incoming loads by destination branch.',
      'Complete GRN at the store when material arrives — this updates stock and closes the quantity gap on the PO.',
      'Review open AP in Procurement → Payments (or Finance) and pay the supplier from the correct treasury account.',
      'If GRN quantities differ from the PO, note the variance on the GRN and align with Finance before paying.',
    ],
    links: [
      { label: 'Procurement', to: '/procurement' },
      { label: 'Operations — stock', to: '/operations' },
      { label: 'Finance', to: '/accounts' },
    ],
  },
  {
    id: 'production-job-workflow',
    title: 'Production job from cutting list to completion',
    keywords: [
      'production job',
      'complete production',
      'job workflow',
      'cutting list to production',
      'finish job',
      'production queue',
      'register output',
      'traceability',
    ],
    answer:
      'Production jobs link back to quotations and cutting lists. The queue shows what is waiting, running, or blocked by material, payment, or manager review.',
    steps: [
      'Confirm the quotation cutting list is ready and payment thresholds are met (Sales + Operations warnings).',
      'Open Operations → Production queue and locate the job; check coil/spec mismatch flags before starting.',
      'Start or resume the job; record meters/weight produced and any offcut returns as required by your branch.',
      'If conversion alerts or manager review appear, resolve them before marking complete — BM/MD approvals may be required.',
      'Complete the job when output is registered; downstream delivery or stock moves may unlock automatically.',
      'Use coil traceability from stock search if you need to audit which coil fed a job.',
    ],
    links: [
      { label: 'Operations', to: '/operations', state: { focusOpsTab: 'production' } },
      { label: 'Sales', to: '/sales' },
    ],
  },
  {
    id: 'refund-approval-workflow',
    title: 'Refund request through approval and payout',
    keywords: [
      'refund process',
      'refund approval',
      'refund workflow',
      'payout refund',
      'approve refund',
      'customer money back',
      'refund stuck',
    ],
    answer:
      'Refunds combine Sales eligibility rules, manager/finance approvals, and treasury payout. A customer hold may block new receipts until the refund clears.',
    steps: [
      'Start the refund from Sales on the quotation or customer record; confirm eligible balance and reason codes.',
      'Submit for manager approval when prompted; track status on the quotation or Refunds tab.',
      'Finance reviews payout readiness in Finance → Payments; treasury disburses from the correct account.',
      'If receipts are blocked, check Manager dashboard clearance and any open refund on the same customer.',
      'After payout, verify the quotation balance and customer hold flags refreshed.',
    ],
    links: [
      { label: 'Sales', to: '/sales' },
      { label: 'Finance — Payments', to: '/accounts', state: { tab: 'payments' } },
      { label: 'Manager dashboard', to: '/manager' },
    ],
  },
  {
    id: 'bank-reconciliation-workflow',
    title: 'Match bank lines to customer receipts',
    keywords: [
      'bank reconciliation workflow',
      'match receipt to bank',
      'unmatched bank',
      'reconcile customer payment',
      'bank line',
      'settlement workflow',
    ],
    answer:
      'Finance reconciliation ties treasury movements and bank import lines to Sales receipts. Unmatched lines stay in the audit queue until cleared.',
    steps: [
      'Open Finance → Receipts & recon (or Treasury first if balances look wrong).',
      'Filter by date/account and locate unmatched bank lines or receipt rows.',
      'Match each bank credit to the correct RCP- receipt; split lines if one deposit covers multiple receipts.',
      'For receipts posted in Sales but not yet on the bank statement, leave them pending rather than forcing a match.',
      'Clear audit checklist items once the period’s matches are complete.',
    ],
    links: [
      { label: 'Finance', to: '/accounts' },
      { label: 'Sales — Payments', to: '/sales', state: { focusSalesTab: 'receipts' } },
    ],
  },
  {
    id: 'material-incident-workflow',
    title: 'Material incident (offcut / return / adjustment)',
    keywords: [
      'material incident',
      'offcut',
      'mex',
      'storekeeper incident',
      'return material',
      'scrap',
      'material exception',
      'incident approval',
    ],
    answer:
      'Material incidents capture non-standard material movements with storekeeper entry and manager approval before stock pools update.',
    steps: [
      'Operations or store creates a material incident with gauge, colour, meters/kg, and reason.',
      'Attach evidence if required; submit for branch manager approval.',
      'After approval/posting, available meters may enter the incident pool for reuse on quotations.',
      'Link incidents to quotations or jobs when consuming pooled material.',
    ],
    links: [{ label: 'Operations', to: '/operations' }],
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

/** @type {Record<string, string[]>} */
const PATH_ARTICLE_BOOSTS = {
  '/sales': ['record-receipt', 'quotation', 'refund', 'cutting-list', 'quote-to-cash-workflow', 'receipt-mistake'],
  '/procurement': ['procurement-po', 'procurement-full-workflow'],
  '/operations': ['operations-production', 'production-job-workflow', 'material-incident-workflow'],
  '/accounts': ['finance-recon', 'bank-reconciliation-workflow', 'period-locked'],
  '/manager': ['customer-hold', 'edit-approval', 'refund-approval-workflow'],
  '/settings': ['settings-access', 'period-locked'],
};

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
 * @returns {boolean}
 */
export function isComplexHelpQuery(query) {
  const q = String(query || '').trim();
  if (q.length > 120) return true;
  if ((q.match(/\?/g) || []).length >= 2) return true;
  if (
    /\b(then|after that|next step|also|and then|step by step|full process|end to end|workflow|walk me through|multiple|whole process)\b/i.test(
      q
    )
  ) {
    return true;
  }
  return false;
}

/**
 * @param {string} message
 * @param {Array<{ role?: string; content?: string }>} [messageHistory]
 * @returns {string}
 */
export function buildHelpSearchText(message, messageHistory) {
  const parts = [String(message || '').trim()];
  if (Array.isArray(messageHistory)) {
    for (const m of messageHistory.slice(-4)) {
      if (m?.role === 'user') parts.push(String(m.content || '').trim());
    }
  }
  return parts.filter(Boolean).join(' ');
}

/**
 * @param {HelpArticle} article
 * @param {string} qLower
 * @param {string[]} tokens
 * @param {string} [pathname]
 * @returns {number}
 */
function scoreHelpArticle(article, qLower, tokens, pathname) {
  let score = 0;
  const titleLower = article.title.toLowerCase();
  if (titleLower.includes(qLower) || qLower.includes(titleLower.slice(0, 14))) {
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
  const p = String(pathname || '');
  for (const [prefix, ids] of Object.entries(PATH_ARTICLE_BOOSTS)) {
    if (p === prefix || p.startsWith(`${prefix}/`)) {
      const idx = ids.indexOf(article.id);
      if (idx >= 0) score += 4 - Math.min(idx, 3);
    }
  }
  return score;
}

/**
 * @param {string} query
 * @param {{ limit?: number; minScore?: number; pathname?: string }} [opts]
 * @returns {{ article: HelpArticle; score: number }[]}
 */
export function matchHelpArticles(query, opts = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  const limit = opts.limit ?? 3;
  const minScore = opts.minScore ?? 4;
  const tokens = tokenizeHelpQuery(q);
  const qLower = q.toLowerCase();
  const ranked = HELP_ARTICLES.map((article) => ({
    article,
    score: scoreHelpArticle(article, qLower, tokens, opts.pathname),
  }))
    .filter((row) => row.score >= minScore)
    .sort((a, b) => b.score - a.score);
  return ranked.slice(0, limit);
}

/**
 * @param {string} query
 * @returns {{ article: HelpArticle; score: number } | null}
 */
export function matchHelpArticle(query) {
  const [best] = matchHelpArticles(query, { limit: 1, minScore: 4 });
  return best ?? null;
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
 * @param {HelpArticle[]} articles
 * @returns {string}
 */
export function formatHelpArticlesReply(articles) {
  const list = Array.isArray(articles) ? articles.filter(Boolean) : [];
  if (!list.length) return '';
  if (list.length === 1) return formatHelpArticleReply(list[0]);
  const lines = [
    '**This touches more than one workflow in Zarewa.**',
    '',
    'Here are the guides that apply — follow them in order:',
  ];
  list.forEach((article, i) => {
    lines.push('', `**${i + 1}. ${article.title}**`, article.answer);
    if (article.steps.length) {
      lines.push('', '**Steps:**');
      article.steps.forEach((step, j) => lines.push(`${j + 1}. ${step}`));
    }
  });
  return lines.join('\n');
}

/**
 * @param {HelpArticle | HelpArticle[]} articleOrList
 * @returns {HelpLink[]}
 */
export function helpArticleLinks(articleOrList) {
  const list = Array.isArray(articleOrList) ? articleOrList : [articleOrList];
  return mergeHelpLinks(list);
}

/**
 * @param {HelpArticle[]} articles
 * @returns {HelpLink[]}
 */
export function mergeHelpLinks(articles) {
  const seen = new Set();
  /** @type {HelpLink[]} */
  const out = [];
  for (const article of articles) {
    for (const link of Array.isArray(article?.links) ? article.links : []) {
      const key = `${link.to}:${link.label}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(link);
    }
  }
  return out;
}

/** Short suggestions shown in the help dock UI. */
export const HELP_QUICK_QUESTIONS = [
  { label: 'Record a payment', query: 'How do I add or record a receipt?' },
  { label: 'Quote to delivery', query: 'Walk me through the full quotation to delivery process' },
  { label: 'PO to payment', query: 'What is the full procurement workflow from PO to supplier payment?' },
  { label: 'I made a mistake', query: 'What should I do if I made a mistake on a payment?' },
  { label: 'Production job', query: 'How do I run a production job from cutting list to completion?' },
  { label: 'Refund process', query: 'Explain the refund approval and payout workflow' },
  { label: 'Bank reconciliation', query: 'How do I match bank lines to customer receipts?' },
  { label: 'Period locked', query: 'Why is the accounting period locked?' },
];

/**
 * @param {string} pathname
 * @returns {typeof HELP_QUICK_QUESTIONS}
 */
export function quickQuestionsForPath(pathname) {
  const p = String(pathname || '');
  if (p.startsWith('/sales')) {
    return [
      { label: 'Record payment', query: 'How do I record a receipt on a quotation?' },
      { label: 'Quote to cash', query: 'Walk me through quotation to delivery' },
      { label: 'Fix receipt mistake', query: 'I posted the wrong receipt amount — what now?' },
      { label: 'Cutting list', query: 'How does the cutting list and payment threshold work?' },
      { label: 'Start a refund', query: 'How does the refund approval workflow work?' },
    ];
  }
  if (p.startsWith('/procurement')) {
    return [
      { label: 'Create a PO', query: 'How do I create and approve a purchase order?' },
      { label: 'PO to payment', query: 'Full workflow from PO to GRN to supplier payment' },
      { label: 'In transit', query: 'How do I post material in transit?' },
    ];
  }
  if (p.startsWith('/operations')) {
    return [
      { label: 'Production job', query: 'Production job from cutting list to completion' },
      { label: 'Stock & coils', query: 'How do stock transfers and coil traceability work?' },
      { label: 'Material incident', query: 'How do material incidents and approvals work?' },
    ];
  }
  if (p.startsWith('/accounts')) {
    return [
      { label: 'Bank reconciliation', query: 'How do I reconcile bank lines to receipts?' },
      { label: 'Treasury', query: 'How do treasury accounts and balances work?' },
      { label: 'Period locked', query: 'Why is the accounting period locked?' },
    ];
  }
  return HELP_QUICK_QUESTIONS.slice(0, 6);
};
