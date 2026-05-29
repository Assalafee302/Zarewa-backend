import { expandHelpTokens, normalizeHelpQueryText, tokenMatchesTerm } from './helpTypoTolerance.js';

/**
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
    id: 'register-staff-user',
    title: 'How to register a new staff user',
    keywords: [
      'register staff',
      'new staff',
      'add staff',
      'add user',
      'create user',
      'new employee',
      'team member',
      'onboard staff',
      'hire',
      'user account',
      'team access',
      'settings team',
    ],
    answer:
      'New ERP logins are created in **Settings → Team & access** by an administrator (settings.manage). This is separate from recording a customer payment or production output.',
    steps: [
      'Open **Settings** from the sidebar.',
      'Open the **Team & access** tab (admin / settings.manage only).',
      'Click **Add user** and enter username, display name, temporary password, role, and branch.',
      'Save — the user can sign in and should update their password under **Settings → Security** if your branch requires it.',
      'Adjust granular permissions on the user row if the role template is not enough.',
    ],
    links: [{ label: 'Settings — Team & access', to: '/settings/team' }],
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
  {
    id: 'all-branches-view-blocked',
    title: 'Cannot create while viewing all branches',
    keywords: [
      'all branches',
      'view all branches',
      'cannot create',
      '403 quotation',
      '403 purchase order',
      'hq roll up',
      'read only all branches',
    ],
    answer:
      'When HQ “view all branches” roll-up is active, new quotations and purchase orders are blocked so data is not posted to the wrong branch.',
    steps: [
      'Switch workspace to a single branch (branch picker in the header or settings).',
      'Confirm the branch badge shows one factory (e.g. Kaduna, Yola, Maiduguri) — not “All branches”.',
      'Retry creating the quotation or PO.',
      'Use all-branches mode for reports and search only; create documents in a specific branch.',
    ],
    links: [{ label: 'Settings', to: '/settings' }],
  },
  {
    id: 'api-offline-degraded',
    title: 'System offline or API degraded',
    keywords: [
      'offline',
      'degraded',
      'api offline',
      'cannot save',
      'boot error',
      'database false',
      'system offline',
      'read only offline',
    ],
    answer:
      'When the live API cannot connect to MySQL or fails boot, the app may show cached data only — nothing new can be saved until the server is healthy.',
    steps: [
      'Check GET /api/health — look for ok, database, and bootPhase.',
      'If database is false: ensure MySQL is running and ZAREWA_MYSQL_* in .env match your host.',
      'Restart the Node API after fixing .env or database.',
      'Use “Reconnect” on the offline banner if shown; otherwise refresh the page.',
      'Do not assume offline edits will sync — re-enter critical data after reconnect.',
    ],
    links: [{ label: 'Settings', to: '/settings' }],
  },
  {
    id: 'document-id-format',
    title: 'Document reference numbers (QT, RCP, PO, etc.)',
    keywords: ['document id', 'reference format', 'qt-kd', 'human id', 'prefix branch', 'serial number'],
    answer:
      'Live documents use PREFIX-BRANCH-YY-NNNN (example QT-KD-26-0001). YY is year; NNNN resets per branch per year on a clean database.',
    steps: [
      'Use global search with the full reference (QT-, RCP-, PO-, RF-, etc.).',
      'Branch segment (KD, YL, MDG) shows which workspace branch owns the document.',
      'Legacy rows without branch may still appear — search by customer name if needed.',
    ],
    links: [{ label: 'Sales', to: '/sales' }],
  },
  {
    id: 'price-exception-workflow',
    title: 'Price below floor / manager & MD price exception',
    keywords: [
      'price exception',
      'below floor',
      'bm approval',
      'md approval',
      'minimum price',
      'commission',
      'pricing workbook',
    ],
    answer:
      'Quotations below material floor or commission rules may require branch manager and sometimes MD confirmation before production or dispatch.',
    steps: [
      'Open the quotation and read the price exception banner.',
      'Branch manager approves in Sales or Manager dashboard when prompted.',
      'If MD review is required, wait for MD confirmation before treating the quote as fully cleared.',
      'Adjust lines or use approved exception — do not bypass by editing posted history.',
    ],
    links: [
      { label: 'Sales — Quotations', to: '/sales', state: { focusSalesTab: 'quotations' } },
      { label: 'Manager dashboard', to: '/manager' },
    ],
  },
  {
    id: 'insufficient-payment-cutting',
    title: 'Not enough payment for cutting list / production',
    keywords: [
      'insufficient payment',
      'payment threshold',
      '50 percent',
      '70 percent',
      'cannot cut',
      'cutting blocked',
      'min paid fraction',
    ],
    answer:
      'Branch policy may require a minimum paid fraction on the quotation before cutting list or production unlocks (often 50–70%).',
    steps: [
      'Open the quotation → Payments tab and compare total paid vs quote total.',
      'Record additional receipts if the customer has paid more.',
      'If policy allows an exception, escalate to branch manager — do not force production without clearance.',
      'Check branch settings / manager targets for the configured fraction.',
    ],
    links: [
      { label: 'Sales — Payments', to: '/sales', state: { focusSalesTab: 'receipts' } },
      { label: 'Manager dashboard', to: '/manager' },
    ],
  },
  {
    id: 'performance-metrics-dashboard',
    title: 'Reading dashboard production & performance metrics',
    keywords: [
      'dashboard metrics',
      'production metrics',
      'performance',
      'meters produced',
      'job count',
      'workspace summary',
      'kpi',
    ],
    answer:
      'The workspace dashboard rolls up production job counts, planned vs actual meters, and cross-module attention flags for your branch scope.',
    steps: [
      'Open Workspace home — review production metrics card and attention banners.',
      'Operations → Production queue for job-level detail.',
      'Manager / Reports for branch roll-ups when you have access.',
      'Metrics refresh on bootstrap — reconnect if numbers look stale after major changes.',
    ],
    links: [
      { label: 'Workspace', to: '/' },
      { label: 'Operations', to: '/operations' },
      { label: 'Reports', to: '/reports' },
    ],
  },
  {
    id: 'transport-fee-finance',
    title: 'PO transport fee and Finance posting',
    keywords: ['transport fee', 'haulage', 'po transport', 'treasury transport', 'freight payment'],
    answer:
      'Purchase order transport charges may appear in Procurement awaiting Finance before treasury posts the fee.',
    steps: [
      'Procurement → link transport on the PO and submit for Finance visibility.',
      'Finance reviews PO transport awaiting treasury on Accounts or Procurement.',
      'Post from the correct branch treasury account.',
      'If savepoint/transaction errors appear, refresh and retry once — avoid double posting.',
    ],
    links: [
      { label: 'Procurement', to: '/procurement' },
      { label: 'Finance', to: '/accounts' },
    ],
  },
  {
    id: 'refund-headroom-categories',
    title: 'Refund categories, headroom, and quotation cap',
    keywords: [
      'refund headroom',
      'refund cap',
      'refund category',
      'categories',
      'exceed headroom',
      'quotation cap',
      'cash on quote',
      'independent categories',
      'refund limit',
      'stack refund',
    ],
    answer:
      'Refunds share one **headroom** per quotation: cash received on that quote minus refunds already approved or paid. Refund **categories** (coil, stone flatsheet, accessories, etc.) are separate entitlements but cannot together exceed available headroom.',
    steps: [
      'Open the refund modal on the quotation — read the headroom / cap banner before selecting lines.',
      'Each category shows what is eligible; only include lines that apply — do not stack categories past total headroom.',
      'If submit is blocked, reduce included lines or confirm extra receipts were posted on **this** quotation.',
      'Stone flatsheet m² and coil substitution follow different rules — use the preview suggestions rather than forcing coil lines on stone-only quotes.',
      'Route through manager/finance approval; payout still requires treasury disbursement.',
    ],
    links: [
      { label: 'Sales — Refunds', to: '/sales', state: { focusSalesTab: 'refund' } },
      { label: 'Refund workflow', to: '/sales' },
      { label: 'Manager dashboard', to: '/manager' },
    ],
  },
  {
    id: 'overpayment-quotation-credit',
    title: 'Overpayment and auto-apply credit on quotations',
    keywords: [
      'overpayment',
      'over pay',
      'overpaid',
      'credit on quote',
      'auto apply',
      'split till',
      'quotation total increased',
      'paid more than',
      'excess payment',
    ],
    answer:
      'When a customer pays more than the current quotation balance, the excess becomes **credit on that quotation**. If the quote total increases later, the system may **auto-apply** existing credit in the open posting period.',
    steps: [
      'Record the full cash received on the quotation — do not manually split unless Finance requires it.',
      'After saving quotation line changes, check the toast/message for overpay re-applied or reconciled.',
      'Refunds use **headroom** based on net cash on the quote — overpayment increases headroom but does not bypass category rules.',
      'If paid amount looks wrong, use Finance reconcile tools or correct-receipt flows before starting a refund.',
    ],
    links: [
      { label: 'Sales — Payments', to: '/sales', state: { focusSalesTab: 'receipts' } },
      { label: 'Sales — Quotations', to: '/sales', state: { focusSalesTab: 'quotations' } },
      { label: 'Finance', to: '/accounts' },
    ],
  },
  {
    id: 'finance-receipt-clearance',
    title: 'Finance clearance before refunds and cleared balances',
    keywords: [
      'receipt clearance',
      'finance clearance',
      'cleared balance',
      'bank confirmed',
      'refund blocked clearance',
      'delivery cleared',
      'finance delivery cleared',
    ],
    answer:
      'Finance may require **receipt clearance** (bank confirmed / delivery cleared) before refunds or certain downstream actions proceed, even when Sales shows a posted receipt.',
    steps: [
      'Sales → Payments: check clearance flags on the receipt row.',
      'Finance → Receipts & recon: confirm bank received amount and mark clearance when matched.',
      'If refund submit fails for clearance, finish Finance steps first — do not bypass in Sales.',
      'Manager clearance on the customer or quote is separate — resolve holds on Manager dashboard if shown.',
    ],
    links: [
      { label: 'Finance', to: '/accounts' },
      { label: 'Sales — Payments', to: '/sales', state: { focusSalesTab: 'receipts' } },
      { label: 'Manager dashboard', to: '/manager' },
    ],
  },
  {
    id: 'material-workbook-pricing',
    title: 'Material workbook pricing and floor list',
    keywords: [
      'workbook pricing',
      'material workbook',
      'floor price',
      'price list',
      'commission',
      'gauge price',
      'pricing workbook',
      'below floor',
      'minimum price',
      'auto price quotation',
    ],
    answer:
      'Quotations for coil/roofing lines can pull **floor prices** from the material pricing workbook (gauge, design, branch). The floor is the minimum allowed before manager exception.',
    steps: [
      'Ensure material pricing workbook is synced for your branch (Settings / pricing ops — per your role).',
      'When adding quotation lines, auto-price uses workbook rows; manual undercuts trigger **price exception** workflow.',
      'Branch manager approves BM exception; MD may confirm for policy — see price exception guide.',
      'Refunds and substitution warnings also reference workbook floors — keep workbook current.',
    ],
    links: [
      { label: 'Sales — Quotations', to: '/sales', state: { focusSalesTab: 'quotations' } },
      { label: 'Settings', to: '/settings' },
      { label: 'Manager dashboard', to: '/manager' },
    ],
  },
  {
    id: 'stone-flatsheet-quotations',
    title: 'Stone-coated & flatsheet quotations and refunds',
    keywords: [
      'stone coated',
      'stone-coated',
      'flatsheet',
      'flat sheet',
      'stone meter',
      'stone m2',
      'm2 refund',
      'stone quotation',
      'single stone profile',
      '1.5m sku',
    ],
    answer:
      'Stone-coated products use **metre or m²** logic distinct from coil roofing. Colours validate against the price list; refunds may include a **stone flatsheet** category separate from coil substitution.',
    steps: [
      'Create quotation lines with stone/flatsheet products — pick colours from the validated workbook list.',
      'Production plans **roofing metres** separately from stone flatsheet usage where applicable.',
      'For refunds, use stone flatsheet category when returning unused sheet area — do not apply coil-gauge substitution warnings to stone-only quotes.',
      'Complete production using stone usage registers; accessories-only stone jobs skip coil requirements.',
    ],
    links: [
      { label: 'Sales — Quotations', to: '/sales', state: { focusSalesTab: 'quotations' } },
      { label: 'Operations', to: '/operations', state: { focusOpsTab: 'production' } },
    ],
  },
  {
    id: 'accessories-only-production',
    title: 'Accessories-only quotes and cutting lists',
    keywords: [
      'accessories only',
      'accessory only',
      'no coil',
      'cutting list accessories',
      'complete stone job accessories',
      'nails screws only',
    ],
    answer:
      'Some quotations are **accessories-only** (no coil roofing lines). Cutting lists and production jobs can still be created and completed without coil picks.',
    steps: [
      'Build the quotation with accessory lines only — no coil product required.',
      'Add cutting list if your process requires it; payment thresholds may still apply per branch policy.',
      'Operations can complete the production job when accessories are supplied — coil traceability steps are skipped.',
      'Refunds use accessory categories, not coil substitution.',
    ],
    links: [
      { label: 'Sales', to: '/sales' },
      { label: 'Operations', to: '/operations' },
    ],
  },
  {
    id: 'company-suppliers-branch-po',
    title: 'Suppliers company-wide vs branch-scoped POs',
    keywords: [
      'supplier branch',
      'company wide supplier',
      'transporter shared',
      'po branch',
      'wrong branch supplier',
      'supplier history branch',
    ],
    answer:
      '**Suppliers and transporters** are shared company-wide. **Purchase orders and receipts** are posted to your **active workspace branch** — supplier history in Procurement may filter by branch context.',
    steps: [
      'Register supplier once — duplicates are blocked/merged on server boot.',
      'Before creating a PO, confirm workspace branch (not “all branches”) in the header.',
      'PO numbers and stock impact belong to the branch you are working in.',
      'Treasury accounts for payment are **branch-scoped** — pick the account for your factory.',
    ],
    links: [
      { label: 'Procurement', to: '/procurement' },
      { label: 'Settings', to: '/settings' },
    ],
  },
  {
    id: 'mixed-procurement-po',
    title: 'Mixed purchase orders (coil, stone, accessories)',
    keywords: [
      'mixed po',
      'mixed purchase order',
      'line type',
      'coil and stone',
      'unified po',
      'multiple line types',
      'procurement kind',
    ],
    answer:
      'One PO can mix **line types** (coil kg, stone/flatsheet, accessories). Procurement kind is derived from lines; GRN finalizes quantities per line.',
    steps: [
      'Procurement → New PO — add each line with correct product/line type.',
      'Approve and post transport/in transit as usual.',
      'Store GRN each line — partial receipts stay open until fully received.',
      'Pay supplier from Procurement/Finance when AP is due for that PO.',
    ],
    links: [{ label: 'Procurement', to: '/procurement' }],
  },
  {
    id: 'grn-weight-variance',
    title: 'GRN weight below ordered (MD alert)',
    keywords: [
      'grn below ordered',
      'short delivery',
      'weight variance',
      'kg below',
      'md alert grn',
      'received less than ordered',
      'coil grn short',
    ],
    answer:
      'When coil GRN lands **below ordered kg**, the system may alert **MD/management** so procurement and finance can investigate before paying full PO value.',
    steps: [
      'Complete GRN with **actual received kg** — do not force full quantity if material short.',
      'Notify procurement lead; adjust PO/payment discussion before supplier payment.',
      'Check in-transit and transport records if haulage loss is suspected.',
      'MD dashboard or alerts list shows the variance for follow-up.',
    ],
    links: [
      { label: 'Procurement', to: '/procurement' },
      { label: 'Operations — stock', to: '/operations' },
      { label: 'Manager dashboard', to: '/manager' },
    ],
  },
  {
    id: 'duplicate-supplier-colour',
    title: 'Duplicate suppliers and coil colours',
    keywords: [
      'duplicate supplier',
      'supplier already exists',
      'duplicate colour',
      'ivory beige',
      'canonical colour',
      'merge colour',
      'setup colours',
      'colour alias',
    ],
    answer:
      'The server **blocks duplicate suppliers** and **merges duplicate setup colours** (e.g. IV vs Ivory Beige) to keep stock and quotations consistent.',
    steps: [
      'If supplier registration fails, search existing suppliers — use the canonical record.',
      'For colours, use names from Settings → Setup master list; avoid new spellings of the same colour.',
      'Stock views unify aliases — if a colour looks duplicated, ask admin to run dedupe migration (automatic on boot).',
      'When quoting, pick validated workbook colours for stone/coil lines.',
    ],
    links: [
      { label: 'Settings', to: '/settings' },
      { label: 'Procurement', to: '/procurement' },
    ],
  },
  {
    id: 'treasury-pay-from-correction',
    title: 'Correcting pay-from / treasury payout mistakes',
    keywords: [
      'pay from correction',
      'wrong treasury account',
      'supplier payment correction',
      'transport payout fix',
      'ap payment wrong account',
      'reverse payout',
    ],
    answer:
      'Finance can **correct pay-from** on supplier, AP, and transport payouts when the wrong treasury account was used — use Finance workflows, not ad-hoc ledger edits.',
    steps: [
      'Open Finance → Payments and locate the disbursement.',
      'Use pay-from correction if your role has access (Finance manager).',
      'Re-post from the correct branch treasury account.',
      'Verify treasury balance and AP status after correction.',
    ],
    links: [{ label: 'Finance — Payments', to: '/accounts', state: { tab: 'payments' } }],
  },
  {
    id: 'manager-payment-hold-clearance',
    title: 'Manager payment hold and clearance',
    keywords: [
      'payment hold',
      'manager hold',
      'clearance inbox',
      'release hold',
      'partial quote cleared',
      'transaction intel',
      'cannot post partial',
    ],
    answer:
      'Branch managers can **hold** or **clear** customer/quote payment posture. Holds block new receipts until cleared; partial quotes may need manager clearance before posting.',
    steps: [
      'Read the error on the receipt form — it often names hold or clearance.',
      'Manager dashboard → Transaction intel / clearance inbox.',
      'Review quote payment history and any open refunds.',
      'Release hold or approve clearance, then retry receipt in Sales.',
    ],
    links: [
      { label: 'Manager dashboard', to: '/manager' },
      { label: 'Sales — Payments', to: '/sales', state: { focusSalesTab: 'receipts' } },
    ],
  },
  {
    id: 'coil-reservation-orphan',
    title: 'Orphan coil reservations (qty_reserved)',
    keywords: [
      'orphan reservation',
      'qty reserved',
      'coil reserved',
      'reconcile reservation',
      'coil profile reservation',
      'reserved but no job',
    ],
    answer:
      'Coil lots show **qty_reserved** when production or cutting lists hold material. **Orphan** reservations (no active job) can be cleared from the coil profile or reconcile API.',
    steps: [
      'Operations or stock → open **coil profile** for the coil number.',
      'Check reserved qty vs active jobs on the quotation/cutting list.',
      'Use **Clear / reconcile reservation** on the profile if shown and you confirmed no active job needs it.',
      'Re-run production queue filters to find jobs still holding coils.',
    ],
    links: [{ label: 'Operations', to: '/operations' }],
  },
  {
    id: 'cutting-list-blocked-running',
    title: 'Cannot edit cutting list — production running',
    keywords: [
      'cutting list blocked',
      'cannot edit cutting list',
      'production running',
      'job running',
      'linked production job',
      'cutting list locked',
    ],
    answer:
      'Cutting lists linked to a **Running** production job cannot be edited — this protects shop-floor traceability.',
    steps: [
      'Check Operations → Production queue for job status on the quotation.',
      'If change is urgent, coordinate with production lead — pause/complete job per policy before editing lines.',
      'PATCH sync may update planned metres on the job when allowed — not while actively running.',
      'For mistakes after production started, use manager/edit-approval paths instead of silent edits.',
    ],
    links: [
      { label: 'Operations', to: '/operations', state: { focusOpsTab: 'production' } },
      { label: 'Sales', to: '/sales' },
    ],
  },
  {
    id: 'sales-expense-request',
    title: 'Sales expense requests (not Finance-only)',
    keywords: [
      'expense request',
      'sales expense',
      'submit expense',
      'expenses.create',
      'petty cash sales',
      'expense approval sales',
    ],
    answer:
      'Sales staff with **expenses.create** can submit expense requests from Sales; Finance approves and posts according to branch policy.',
    steps: [
      'Sales workspace → expense request panel (if your role shows it).',
      'Fill amount, category, and reference; submit for approval.',
      'Track status — Finance may need to approve before ledger posting.',
      'If panel is hidden, ask admin to confirm role permissions include expenses.create.',
    ],
    links: [
      { label: 'Sales', to: '/sales' },
      { label: 'Finance', to: '/accounts' },
      { label: 'Edit approvals', to: '/edit-approvals' },
    ],
  },
  {
    id: 'duplicate-payment-alert',
    title: 'Duplicate payment detection',
    keywords: [
      'duplicate payment',
      'duplicate receipt',
      'already paid',
      'same amount twice',
      'double payment',
      'alert duplicate',
    ],
    answer:
      'The app may **alert** when a receipt looks like a duplicate of an existing payment on the same quotation (same amount/date pattern).',
    steps: [
      'Stop and verify with the customer/treasury before posting again.',
      'Open quotation payment history — confirm whether RCP- already exists.',
      'If first post failed partially, use receipt correction flows instead of a second duplicate.',
      'Manager dashboard may show duplicate-payment intel for review.',
    ],
    links: [
      { label: 'Sales — Payments', to: '/sales', state: { focusSalesTab: 'receipts' } },
      { label: 'Manager dashboard', to: '/manager' },
    ],
  },
  {
    id: 'in-transit-transport-link',
    title: 'Link transport on in-transit POs',
    keywords: [
      'in transit transport',
      'assign haulier',
      'transport not set',
      'link transport in transit',
      'po in transit',
      'haulage assign',
    ],
    answer:
      'POs already **in transit** can still receive **transport agent or fee** updates when haulier was not set at dispatch.',
    steps: [
      'Open the PO in Procurement — in transit status.',
      'Assign or update transport agent and fee lines.',
      'Finance may post transport fee separately — watch for savepoint errors; refresh once and retry.',
      'Complete GRN at destination branch when material arrives.',
    ],
    links: [{ label: 'Procurement', to: '/procurement' }],
  },
  {
    id: 'branch-treasury-scope',
    title: 'Branch-scoped treasury bank accounts',
    keywords: [
      'treasury branch',
      'bank account branch',
      'yola account',
      'maiduguri treasury',
      'kaduna hq account',
      'wrong branch account',
      'create treasury branch',
    ],
    answer:
      'Treasury **bank accounts** belong to a workspace branch. Receipts and payouts must use an account for the branch you are working in.',
    steps: [
      'Finance → Treasury: filter by your workspace branch.',
      'When recording receipts, pick the account for your factory — not another branch’s account.',
      'Creating new accounts requires branch context (not all-branches view).',
      'Legacy accounts may have been backfilled to Kaduna HQ — confirm with Finance if balances look wrong.',
    ],
    links: [{ label: 'Finance', to: '/accounts' }],
  },
  {
    id: 'wrong-customer-payment-correction',
    title: 'Wrong customer on a payment',
    keywords: [
      'wrong customer',
      'wrong client payment',
      'posted wrong customer',
      'customer payment wrong',
      'paid wrong account',
    ],
    answer:
      'If cash was posted to the wrong customer, do not silently reassign ledger rows. Finance needs an audit trail via correction memo or reversal.',
    steps: [
      'Confirm receipt reference(s) and the correct customer on the quotation.',
      'Raise a **Wrong Customer Payment Report** with proof (bank slip, customer confirmation).',
      'Branch Manager reviews; Finance reverses or re-posts to the correct customer.',
      'Attach supporting documents before approval.',
    ],
    links: [
      { label: 'Sales — Payments', to: '/sales', state: { focusSalesTab: 'receipts' } },
      { label: 'Finance', to: '/accounts' },
    ],
  },
  {
    id: 'receipt-reversal-process',
    title: 'Receipt reversal process',
    keywords: [
      'reverse receipt',
      'reversal',
      'undo receipt',
      'cancel posted receipt',
      'receipt reversal',
    ],
    answer:
      'Posted receipts are reversed through Finance — not deleted. After reversal you may record the correct payment again.',
    steps: [
      'Open the posted receipt and note reference, amount, and customer.',
      'Raise a **Receipt Reversal Request** memo with reason and proof.',
      'Finance/manager approves reversal per clearance rules.',
      'Record the correct receipt on the right quotation once cleared.',
    ],
    links: [
      { label: 'Finance', to: '/accounts', state: { accountsTab: 'receipts' } },
      { label: 'Edit approvals', to: '/edit-approvals' },
    ],
  },
  {
    id: 'cannot-approve-troubleshoot',
    title: 'Why approval is blocked',
    keywords: [
      'cannot approve',
      "can't approve",
      'approval blocked',
      'why cant i approve',
      'approval disabled',
      'clearance',
    ],
    answer:
      'Approval buttons stay disabled when clearance, branch scope, attachments, status, or locked periods block the action.',
    steps: [
      'Check your role clearance vs the request amount.',
      'Confirm the item belongs to your branch (or you have cross-branch approval).',
      'Verify required attachments are present.',
      'Check if the item is already approved, rejected, or in a locked period.',
      'Escalate to Branch Manager or Finance with an Approval Error Report memo if needed.',
    ],
    links: [
      { label: 'Manager dashboard', to: '/manager' },
      { label: 'Edit approvals', to: '/edit-approvals' },
      { label: 'Settings — governance', to: '/settings/governance' },
    ],
  },
  {
    id: 'expense-correction-workflow',
    title: 'Expense correction workflow',
    keywords: [
      'wrong expense',
      'expense correction',
      'fix expense amount',
      'expense mistake',
      'wrong expense amount',
    ],
    answer:
      'Approved or paid expenses should be corrected through memo + Finance review, not silent edits.',
    steps: [
      'If still draft and editable, fix amount/category before submission.',
      'If submitted or approved, raise an **Expense Correction Request** with references and proof.',
      'Branch Manager → Finance reviews and adjusts per policy.',
    ],
    links: [
      { label: 'Finance', to: '/accounts' },
      { label: 'Workspace', to: '/' },
    ],
  },
  {
    id: 'wrong-branch-transaction',
    title: 'Wrong branch on a transaction',
    keywords: ['wrong branch', 'other branch', 'branch mistake', 'posted wrong branch'],
    answer: 'Transactions are branch-scoped. Wrong-branch posts need manager/Finance correction with audit trail.',
    steps: [
      'Confirm which branch should own the transaction.',
      'Do not delete — raise a memo describing wrong branch, reference, and correct branch.',
      'HQ/Finance reviews treasury and ledger impact before correction.',
    ],
    links: [
      { label: 'Settings — team', to: '/settings/team' },
      { label: 'Finance', to: '/accounts' },
    ],
  },
  {
    id: 'stock-inventory-correction',
    title: 'Stock / inventory correction',
    keywords: [
      'wrong stock',
      'inventory correction',
      'wrong quantity',
      'stock mistake',
      'grn wrong qty',
    ],
    answer: 'Inventory corrections use material incidents, GRN adjustments, or manager-approved corrections — not ad-hoc deletes.',
    steps: [
      'Identify SKU/coil/register reference and wrong vs correct quantity.',
      'Raise stock correction memo or material incident per Operations policy.',
      'Attach GRN or weighbridge proof; Operations + Manager approve.',
    ],
    links: [
      { label: 'Operations', to: '/operations' },
      { label: 'Procurement', to: '/procurement' },
    ],
  },
  {
    id: 'maintenance-memo-workflow',
    title: 'Raising a maintenance / repairs memo',
    keywords: [
      'maintenance memo',
      'machine broken',
      'machine spoil',
      'repair memo',
      'mechanic',
      'maintenance request',
    ],
    answer:
      'Maintenance memos should describe the fault, attach mechanic report or quotation, and route to Branch Manager before expense/procurement conversion.',
    steps: [
      'Compose memo → Maintenance / Repairs type.',
      'Attach mechanic quotation or fault report.',
      'Send to Branch Manager; convert to expense or procurement when payment is needed.',
    ],
    links: [{ label: 'Workspace — Compose', to: '/' }],
  },
  {
    id: 'diesel-fuel-memo-workflow',
    title: 'Diesel / fuel request memo',
    keywords: [
      'diesel',
      'fuel',
      'gen no diesel',
      'generator fuel',
      'litres',
      'fuel request',
    ],
    answer:
      'Fuel memos need litres, vendor, and estimated amount before approval. Urgent generator downtime should be marked high priority.',
    steps: [
      'Compose memo → Diesel / fuel request.',
      'Enter litres, vendor, estimated amount, and branch.',
      'Attach delivery note or vendor quote if available.',
      'Branch Manager approves; convert to expense if payment is required.',
    ],
    links: [{ label: 'Workspace', to: '/' }],
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
  '/sales': [
    'record-receipt',
    'quotation',
    'refund',
    'refund-headroom-categories',
    'cutting-list',
    'quote-to-cash-workflow',
    'receipt-mistake',
    'overpayment-quotation-credit',
    'finance-receipt-clearance',
    'material-workbook-pricing',
    'price-exception-workflow',
  ],
  '/procurement': [
    'procurement-po',
    'procurement-full-workflow',
    'mixed-procurement-po',
    'grn-weight-variance',
    'in-transit-transport-link',
    'company-suppliers-branch-po',
  ],
  '/operations': [
    'operations-production',
    'production-job-workflow',
    'material-incident-workflow',
    'coil-reservation-orphan',
    'cutting-list-blocked-running',
    'stone-flatsheet-quotations',
    'accessories-only-production',
  ],
  '/accounts': [
    'finance-recon',
    'bank-reconciliation-workflow',
    'period-locked',
    'finance-receipt-clearance',
    'treasury-pay-from-correction',
    'branch-treasury-scope',
  ],
  '/manager': [
    'customer-hold',
    'manager-payment-hold-clearance',
    'edit-approval',
    'refund-approval-workflow',
    'refund-headroom-categories',
    'grn-weight-variance',
  ],
  '/settings': [
    'register-staff-user',
    'settings-access',
    'period-locked',
    'duplicate-supplier-colour',
    'material-workbook-pricing',
  ],
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
  const parts = [normalizeHelpQueryText(String(message || '').trim())];
  if (Array.isArray(messageHistory)) {
    for (const m of messageHistory.slice(-4)) {
      if (m?.role === 'user') parts.push(normalizeHelpQueryText(String(m.content || '').trim()));
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
function scoreHelpArticle(article, qLower, tokens, pathname, learnedBoosts) {
  let score = 0;
  const titleLower = article.title.toLowerCase();
  if (titleLower.includes(qLower) || qLower.includes(titleLower.slice(0, 14))) {
    score += 8;
  }
  for (const kw of article.keywords) {
    const k = kw.toLowerCase();
    if (qLower.includes(k)) score += 6;
    else if (tokens.some((t) => k.includes(t) || t.includes(k) || tokenMatchesTerm(t, k))) score += 3;
    else if (tokens.some((t) => k.split(/\s+/).some((part) => tokenMatchesTerm(t, part)))) score += 2;
  }
  for (const token of tokens) {
    if (titleLower.includes(token)) score += 2;
    else if (titleLower.split(/\s+/).some((w) => tokenMatchesTerm(token, w))) score += 1;
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
  const boost = Number(learnedBoosts?.[article.id]) || 0;
  if (boost > 0) score += boost;
  return score;
}

/**
 * @param {string} query
 * @param {{ limit?: number; minScore?: number; pathname?: string; learnedBoosts?: Record<string, number> }} [opts]
 * @returns {{ article: HelpArticle; score: number }[]}
 */
export function matchHelpArticles(query, opts = {}) {
  const q = String(query || '').trim();
  if (!q) return [];
  const limit = opts.limit ?? 3;
  const minScore = opts.minScore ?? 4;
  const normalized = normalizeHelpQueryText(q);
  const tokens = expandHelpTokens(tokenizeHelpQuery(`${q} ${normalized}`));
  const qLower = `${q} ${normalized}`.toLowerCase();
  const learnedBoosts = opts.learnedBoosts && typeof opts.learnedBoosts === 'object' ? opts.learnedBoosts : {};
  const ranked = HELP_ARTICLES.map((article) => ({
    article,
    score: scoreHelpArticle(article, qLower, tokens, opts.pathname, learnedBoosts),
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
  { label: 'Refund headroom', query: 'How do refund categories and quotation headroom work?' },
  { label: 'Overpayment credit', query: 'Customer overpaid on the quotation — what happens?' },
  { label: 'Quote to delivery', query: 'Walk me through the full quotation to delivery process' },
  { label: 'Workbook pricing', query: 'How does material workbook pricing and floor price work?' },
  { label: 'Stone flatsheet', query: 'Stone-coated flatsheet quotations and refunds' },
  { label: 'PO to payment', query: 'What is the full procurement workflow from PO to supplier payment?' },
  { label: 'All-branches blocked', query: 'Why can I not create a quotation in all-branches view?' },
];

/**
 * @param {string} pathname
 * @returns {typeof HELP_QUICK_QUESTIONS}
 */
export function quickQuestionsForPath(pathname) {
  const p = String(pathname || '');
  if (p.startsWith('/sales')) {
    return [
      { label: 'What next?', query: 'What should I do next on this receipt?' },
      { label: 'Wrong payment', query: 'I entered the wrong payment amount — what should I do?' },
      { label: 'Cannot approve', query: 'Why can’t I approve this?' },
      { label: 'Record payment', query: 'How do I record a receipt on a quotation?' },
      { label: 'Refund headroom', query: 'Refund categories and quotation headroom cap' },
      { label: 'Overpayment', query: 'Customer overpaid — auto-apply credit on quotation' },
      { label: 'Workbook price', query: 'Material workbook floor pricing on quotations' },
      { label: 'Stone flatsheet', query: 'Stone-coated flatsheet quotation and refund rules' },
      { label: 'Cutting list blocked', query: 'Cannot edit cutting list while production running' },
    ];
  }
  if (p.startsWith('/procurement')) {
    return [
      { label: 'Mixed PO', query: 'Mixed purchase order with coil stone and accessories' },
      { label: 'PO to payment', query: 'Full workflow from PO to GRN to supplier payment' },
      { label: 'GRN short weight', query: 'GRN received below ordered kg MD alert' },
      { label: 'In-transit transport', query: 'Link transport on in-transit PO' },
      { label: 'Duplicate supplier', query: 'Duplicate supplier registration blocked' },
    ];
  }
  if (p.startsWith('/operations')) {
    return [
      { label: 'Production job', query: 'Production job from cutting list to completion' },
      { label: 'Coil reservation', query: 'Orphan coil qty_reserved reconcile' },
      { label: 'Accessories only', query: 'Accessories-only quotation production complete' },
      { label: 'Material incident', query: 'How do material incidents and approvals work?' },
    ];
  }
  if (p.startsWith('/accounts')) {
    return [
      { label: 'Correction memo', query: 'How do I raise a payment correction memo?' },
      { label: 'Duplicate receipt', query: 'I created a duplicate receipt — what should I do?' },
      { label: 'Receipt clearance', query: 'Finance clearance before refunds' },
      { label: 'Pay-from fix', query: 'Correct pay-from treasury payout mistake' },
      { label: 'Branch treasury', query: 'Branch-scoped treasury bank accounts' },
      { label: 'Bank reconciliation', query: 'How do I reconcile bank lines to receipts?' },
    ];
  }
  if (p.startsWith('/manager')) {
    return [
      { label: 'Payment hold', query: 'Manager payment hold and clearance' },
      { label: 'Refund headroom', query: 'Refund categories and quotation cap' },
      { label: 'GRN variance', query: 'GRN below ordered weight alert' },
      { label: 'Edit approvals', query: 'How do second approvals work?' },
    ];
  }
  if (p.startsWith('/settings')) {
    return [
      { label: 'Register staff', query: 'How do I register a new staff user?' },
      { label: 'Team access', query: 'Settings team access and permissions' },
      { label: 'Period lock', query: 'Accounting period locked — what can I do?' },
      { label: 'Governance', query: 'Settings governance and period locks' },
    ];
  }
  return HELP_QUICK_QUESTIONS.slice(0, 6);
};
