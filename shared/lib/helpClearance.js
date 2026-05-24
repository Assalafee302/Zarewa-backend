/**
 * Clearance-aware help — users may ask anything; live data is gated, workflows still explained.
 */

/** @typedef {{ permissions: string[]; label: string; escalateTo: string }} ClearanceTopic */

/** @type {Record<string, ClearanceTopic>} */
export const CLEARANCE_TOPICS = {
  inventory: {
    permissions: ['sales.view', 'operations.view', 'inventory.view', '*'],
    label: 'inventory / stock levels',
    escalateTo: 'Operations or Sales',
  },
  finance: {
    permissions: ['finance.view', 'accounts.view', '*'],
    label: 'finance ledger and treasury data',
    escalateTo: 'Finance',
  },
  refunds: {
    permissions: ['sales.view', 'refunds.view', 'refunds.approve', '*'],
    label: 'customer refunds',
    escalateTo: 'Sales or Finance',
  },
  quotations: {
    permissions: ['sales.view', 'quotations.view', '*'],
    label: 'quotation records',
    escalateTo: 'Sales',
  },
  procurement: {
    permissions: ['procurement.view', 'operations.view', '*'],
    label: 'purchase orders and procurement',
    escalateTo: 'Procurement',
  },
  audit: {
    permissions: ['audit.view', '*'],
    label: 'full audit log (other users)',
    escalateTo: 'Admin or MD',
  },
  manager: {
    permissions: ['reports.view', '*'],
    label: 'management reports and executive data',
    escalateTo: 'your branch manager or MD',
  },
  hr: {
    permissions: ['hr.view', '*'],
    label: 'HR and payroll data',
    escalateTo: 'HR or Admin',
  },
};

export const ARTICLE_CLEARANCE_TOPIC = {
  'record-receipt': 'finance',
  'receipt-mistake': 'finance',
  'finance-receipt-clearance': 'finance',
  'refund-headroom-categories': 'refunds',
  'refund-approval-workflow': 'refunds',
  'quote-to-cash-workflow': 'quotations',
  'procurement-full-workflow': 'procurement',
  'production-job-workflow': 'inventory',
};

/**
 * @param {{ permissions?: string[] } | null | undefined} user
 * @param {string[]} required
 */
export function userHasClearance(user, required) {
  if (!user) return false;
  const perms = Array.isArray(user.permissions) ? user.permissions : [];
  if (perms.includes('*')) return true;
  return required.some((p) => perms.includes(p));
}

/**
 * @param {string} message
 * @returns {string | null}
 */
export function inferClearanceTopicFromMessage(message) {
  const q = String(message || '').toLowerCase();
  if (/\b(inventory|stock|product level)\b/.test(q)) return 'inventory';
  if (/\b(refund|rf-)\b/.test(q)) return 'refunds';
  if (/\b(quotation|qt-|quote)\b/.test(q)) return 'quotations';
  if (/\b(ledger|treasury|receipt|finance|bank|payment posted)\b/.test(q)) return 'finance';
  if (/\b(purchase order|po-|procurement|grn)\b/.test(q)) return 'procurement';
  if (/\b(payroll|salary|hr staff)\b/.test(q)) return 'hr';
  if (/\b(management report|executive|md dashboard)\b/.test(q)) return 'manager';
  if (/\b(audit log|who changed)\b/.test(q)) return 'audit';
  return null;
}

/**
 * @param {string} articleId
 */
export function inferClearanceTopicFromArticle(articleId) {
  const id = String(articleId || '');
  for (const [prefix, topic] of Object.entries(ARTICLE_CLEARANCE_TOPIC)) {
    if (id === prefix || id.startsWith(prefix)) return topic;
  }
  if (/refund/i.test(id)) return 'refunds';
  if (/finance|receipt|treasury|period/i.test(id)) return 'finance';
  if (/procurement|po|grn/i.test(id)) return 'procurement';
  return null;
}

/**
 * @param {{
 *   topicKey: string;
 *   roleKey?: string;
 *   mode?: 'live_data' | 'guide';
 *   includeWorkflowOffer?: boolean;
 * }} opts
 */
export function formatClearanceMessage(opts) {
  const topic = CLEARANCE_TOPICS[opts.topicKey] || {
    label: 'that data',
    escalateTo: 'your supervisor',
    permissions: [],
  };
  const role = String(opts.roleKey || 'your role').replace(/_/g, ' ');
  const lines = [
    `**Clearance note:** Your current access (${role}) does not include **live ${topic.label}** in Zarewa.`,
    '',
    `You can still ask **how the workflow works** — I'll explain the steps without showing restricted records.`,
  ];
  if (opts.mode === 'live_data') {
    lines.push('', `For actual numbers or records, ask **${topic.escalateTo}** or request access from Admin.`);
  } else {
    lines.push('', `To run this in the system yourself, you may need **${topic.escalateTo}**.`);
  }
  if (opts.includeWorkflowOffer !== false) {
    lines.push('', '_Tip: "How do I …" = procedure · "Show me / what is …" = live data._');
  }
  return lines.join('\n');
}

/**
 * @param {import('./helpKnowledge.js').HelpArticle} article
 * @param {{ permissions?: string[]; roleKey?: string } | null | undefined} user
 */
export function guideClearanceFootnote(article, user) {
  const topicKey = inferClearanceTopicFromArticle(article?.id);
  if (!topicKey) return null;
  const topic = CLEARANCE_TOPICS[topicKey];
  if (!topic || userHasClearance(user, topic.permissions)) return null;
  return `_**Your clearance:** This describes ${topic.label}. Your role can read the steps but may not see live data or run all actions — contact ${topic.escalateTo}._`;
}

/**
 * @param {string[]} tables
 */
export function clearanceTopicForTables(tables) {
  const set = new Set((tables || []).map((t) => String(t).toLowerCase()));
  if (set.has('products')) return 'inventory';
  if (set.has('customer_refunds')) return 'refunds';
  if (set.has('quotations')) return 'quotations';
  if (set.has('ledger_entries')) return 'finance';
  if (set.has('purchase_orders')) return 'procurement';
  if (set.has('audit_log')) return 'audit';
  return null;
}
