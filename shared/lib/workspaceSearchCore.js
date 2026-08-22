/**
 * Shared workspace quick-search scoring, merge, grouping, and navigation commands.
 * Frontend copies via `npm run sync:shared` → src/shared/lib/workspaceSearchCore.js
 */

/** @typedef {{ kind: string, id: string, label: string, sublabel?: string, path: string, state?: object, _score?: number }} WorkspaceSearchHit */

export const WORKSPACE_SEARCH_KIND_LABELS = {
  nav: 'Go to',
  customer: 'Customer',
  quotation: 'Quotation',
  receipt: 'Receipt',
  purchase_order: 'Purchase order',
  supplier: 'Supplier',
  cutting_list: 'Cutting list',
  coil: 'Coil',
  refund: 'Refund',
  product: 'Product',
  hr_staff: 'Staff',
  gl_journal: 'GL journal',
  work_item: 'Work item',
  production_job: 'Production job',
  delivery: 'Delivery',
  payment_request: 'Payment request',
  expense: 'Expense',
  ledger_entry: 'Ledger entry',
};

/**
 * Bounded Levenshtein distance (early exit when above max).
 * @param {string} a
 * @param {string} b
 * @param {number} [maxDist]
 */
export function levenshteinDistance(a, b, maxDist = 2) {
  const s = String(a || '').toLowerCase();
  const t = String(b || '').toLowerCase();
  if (s === t) return 0;
  if (!s.length) return t.length <= maxDist ? t.length : maxDist + 1;
  if (!t.length) return s.length <= maxDist ? s.length : maxDist + 1;
  if (Math.abs(s.length - t.length) > maxDist) return maxDist + 1;

  let prev = new Array(t.length + 1);
  let curr = new Array(t.length + 1);
  for (let j = 0; j <= t.length; j++) prev[j] = j;

  for (let i = 1; i <= s.length; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= t.length; j++) {
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      rowMin = Math.min(rowMin, curr[j]);
    }
    if (rowMin > maxDist) return maxDist + 1;
    const swap = prev;
    prev = curr;
    curr = swap;
  }
  return prev[t.length];
}

/** @param {string} q @param {string} word */
function fuzzyWordScore(q, word) {
  if (!q || !word || q.length < 3 || word.length < 3) return 0;
  const maxDist = q.length <= 4 ? 1 : 2;
  const dist = levenshteinDistance(q, word, maxDist);
  if (dist > maxDist) return 0;
  if (dist === 0) return 950;
  if (dist === 1) return 420;
  return 360;
}

/** Route-prefix → entity-kind score boost (current page context). */
export const WORKSPACE_SEARCH_CONTEXT_KIND_BOOSTS = {
  '/sales': { customer: 90, quotation: 110, receipt: 100, refund: 80 },
  '/customers': { customer: 130 },
  '/procurement': { purchase_order: 110, supplier: 100 },
  '/operations': { coil: 110, cutting_list: 100, production_job: 100, delivery: 90, product: 80 },
  '/accounts': { payment_request: 110, expense: 100, gl_journal: 100, receipt: 70, ledger_entry: 80 },
  '/accounting': { gl_journal: 130, expense: 90 },
  '/hr': { hr_staff: 130 },
  '/': { work_item: 90 },
};

/** @param {string} [contextPath] */
export function resolveWorkspaceSearchContextBoosts(contextPath) {
  const path = String(contextPath || '').split('?')[0].trim() || '/';
  const ordered = Object.entries(WORKSPACE_SEARCH_CONTEXT_KIND_BOOSTS).sort(
    (a, b) => b[0].length - a[0].length
  );
  for (const [prefix, boosts] of ordered) {
    if (prefix === '/' && path === '/') return boosts;
    if (prefix !== '/' && (path === prefix || path.startsWith(`${prefix}/`))) return boosts;
  }
  return {};
}

/** @param {WorkspaceSearchHit[]} rows @param {string} [contextPath] */
export function applyContextBoostToSearchRows(rows, contextPath) {
  const boosts = resolveWorkspaceSearchContextBoosts(contextPath);
  if (!Object.keys(boosts).length) return rows || [];
  return (rows || []).map((row) => ({
    ...row,
    _score: (row._score ?? 0) + (boosts[row.kind] ?? 0),
  }));
}

/** @param {Record<string, WorkspaceSearchHit[]>} byKind @param {string} [contextPath] */
export function applyContextBoostToByKind(byKind, contextPath) {
  const out = {};
  for (const [kind, rows] of Object.entries(byKind || {})) {
    out[kind] = applyContextBoostToSearchRows(rows, contextPath);
  }
  return out;
}

export function workspaceSearchKindLabel(kind) {
  return WORKSPACE_SEARCH_KIND_LABELS[kind] || String(kind || '').replace(/_/g, ' ');
}

/**
 * Score a search match across field values. Higher = better.
 * @param {string} rawQuery
 * @param {string|string[]} fields
 */
export function scoreWorkspaceSearchMatch(rawQuery, fields) {
  const q = String(rawQuery || '').trim().toLowerCase();
  if (!q || q.length < 2) return 0;
  const list = (Array.isArray(fields) ? fields : [fields])
    .map((f) => String(f ?? '').trim())
    .filter(Boolean);
  if (!list.length) return 0;

  let best = 0;
  const qDigits = q.replace(/\D/g, '');

  for (const raw of list) {
    const f = raw.toLowerCase();
    if (f === q) best = Math.max(best, 1000);
    else if (f.startsWith(q)) best = Math.max(best, 850);
    else {
      const idx = f.indexOf(q);
      if (idx >= 0) best = Math.max(best, 500 - Math.min(idx, 80));
    }
    for (const word of f.split(/\s+/)) {
      if (!word) continue;
      if (word === q) best = Math.max(best, 950);
      else if (word.startsWith(q)) best = Math.max(best, 720);
    }
    if (qDigits.length >= 2) {
      const fDigits = raw.replace(/\D/g, '');
      if (fDigits.includes(qDigits)) best = Math.max(best, 620);
    }
    if (best === 0 && q.length >= 3) {
      for (const word of f.split(/\s+/)) {
        best = Math.max(best, fuzzyWordScore(q, word));
      }
      if (best === 0 && f.length >= 3 && f.length <= 48) {
        best = Math.max(best, fuzzyWordScore(q, f));
      }
    }
  }
  return best;
}

/**
 * @param {WorkspaceSearchHit} hit
 */
export function stripSearchScore(hit) {
  if (!hit || typeof hit !== 'object') return hit;
  const { _score, ...rest } = hit;
  return rest;
}

/**
 * Merge categorized hits with per-kind minimums, then fill by global score.
 * @param {Record<string, WorkspaceSearchHit[]>} byKind
 */
export function mergeWorkspaceSearchResults(byKind, { totalCap = 18, minPerKind = 2 } = {}) {
  const cap = Math.max(1, totalCap | 0);
  const minK = Math.max(0, minPerKind | 0);

  const sortedByKind = {};
  for (const [kind, rows] of Object.entries(byKind || {})) {
    sortedByKind[kind] = [...(rows || [])]
      .filter((r) => r && (r._score ?? 0) > 0)
      .sort(
        (a, b) =>
          (b._score ?? 0) - (a._score ?? 0) ||
          String(a.label || '').localeCompare(String(b.label || ''))
      );
  }

  const picked = [];
  const seen = new Set();
  const pick = (row) => {
    const key = `${row.kind}:${row.id}`;
    if (seen.has(key) || picked.length >= cap) return false;
    seen.add(key);
    picked.push(row);
    return true;
  };

  for (const rows of Object.values(sortedByKind)) {
    for (const row of rows.slice(0, minK)) pick(row);
  }

  const pool = Object.values(sortedByKind)
    .flat()
    .filter((r) => !seen.has(`${r.kind}:${r.id}`))
    .sort(
      (a, b) =>
        (b._score ?? 0) - (a._score ?? 0) ||
        String(a.label || '').localeCompare(String(b.label || ''))
    );

  for (const row of pool) {
    if (picked.length >= cap) break;
    pick(row);
  }

  return picked.map(stripSearchScore);
}

/** @param {WorkspaceSearchHit[]} hits */
export function groupWorkspaceSearchHits(hits) {
  const groups = [];
  const map = new Map();
  for (const hit of hits || []) {
    const kind = hit?.kind || 'other';
    if (!map.has(kind)) {
      const g = { kind, label: workspaceSearchKindLabel(kind), items: [] };
      map.set(kind, g);
      groups.push(g);
    }
    map.get(kind).items.push(hit);
  }
  return groups;
}

/** @returns {{ text: string, match: boolean }[]} */
export function splitSearchHighlight(text, rawQuery) {
  const src = String(text ?? '');
  const q = String(rawQuery ?? '').trim();
  if (!q) return [{ text: src, match: false }];
  const idx = src.toLowerCase().indexOf(q.toLowerCase());
  if (idx < 0) return [{ text: src, match: false }];
  return [
    { text: src.slice(0, idx), match: false },
    { text: src.slice(idx, idx + q.length), match: true },
    { text: src.slice(idx + q.length), match: false },
  ].filter((s) => s.text);
}

/** @typedef {{ kind: 'nav', id: string, label: string, sublabel?: string, path: string, state?: object, keywords: string[], module?: string, permissions?: string[], roleKeys?: string[] }} WorkspaceNavSearchCommand */

/** @type {WorkspaceNavSearchCommand[]} */
export const WORKSPACE_NAV_SEARCH_COMMANDS = [
  {
    kind: 'nav',
    id: 'nav-home',
    label: 'Workspace',
    sublabel: 'Home inbox',
    path: '/',
    keywords: ['workspace', 'home', 'inbox', 'office', 'memo'],
  },
  {
    kind: 'nav',
    id: 'nav-sales',
    label: 'Sales',
    sublabel: 'Quotations & customers',
    path: '/sales',
    keywords: ['sales', 'quotation', 'quote', 'customer', 'receipt', 'crm'],
    module: 'sales',
  },
  {
    kind: 'nav',
    id: 'nav-procurement',
    label: 'Procurement',
    sublabel: 'Procurement & suppliers',
    path: '/procurement',
    keywords: ['procurement', 'purchase', 'supplier', 'po', 'buy'],
    module: 'procurement',
  },
  {
    kind: 'nav',
    id: 'nav-operations',
    label: 'Production',
    sublabel: 'Operations & inventory',
    path: '/operations',
    state: { focusOpsTab: 'production' },
    keywords: ['production', 'operations', 'inventory', 'coil', 'cutting', 'factory'],
    module: 'operations',
  },
  {
    kind: 'nav',
    id: 'nav-finance',
    label: 'Finance',
    sublabel: 'Accounts & treasury',
    path: '/accounts',
    keywords: ['finance', 'accounts', 'treasury', 'ledger', 'cashier', 'bank'],
    permissions: [
      'finance.view',
      'finance.post',
      'finance.pay',
      'finance.approve',
      'finance.reverse',
      'treasury.manage',
      'cashier.desk.view',
      'cashier.receipts.confirm',
    ],
  },
  {
    kind: 'nav',
    id: 'nav-accounting',
    label: 'Accounting',
    sublabel: 'Accounting desk',
    path: '/accounting',
    keywords: ['accounting', 'gl', 'journal', 'ledger', 'books'],
    permissions: ['finance.view', 'finance.post', 'finance.approve', 'period.manage', 'audit.view'],
  },
  {
    kind: 'nav',
    id: 'nav-reports',
    label: 'Reports',
    sublabel: 'Management reports',
    path: '/reports',
    keywords: ['reports', 'report', 'analytics'],
    module: 'reports',
  },
  {
    kind: 'nav',
    id: 'nav-hr',
    label: 'HR operations',
    sublabel: 'Staff directory',
    path: '/hr',
    keywords: ['hr', 'staff', 'employee', 'people', 'human resources'],
    permissions: ['hr.directory.view', 'hr.staff.manage'],
  },
  {
    kind: 'nav',
    id: 'nav-settings',
    label: 'Settings',
    sublabel: 'System configuration',
    path: '/settings',
    keywords: ['settings', 'config', 'admin', 'users', 'roles'],
    module: 'settings',
  },
  {
    kind: 'nav',
    id: 'nav-manager',
    label: 'Management',
    sublabel: 'Manager dashboard',
    path: '/manager',
    keywords: ['manager', 'management', 'dashboard', 'queue'],
    permissions: ['manager.dashboard'],
  },
  {
    kind: 'nav',
    id: 'nav-exec',
    label: 'Executive Office',
    sublabel: 'Executive overview',
    path: '/exec',
    keywords: ['exec', 'executive', 'command', 'md', 'ceo', 'office'],
    permissions: ['exec.dashboard.view'],
  },
];

/**
 * @param {string} rawQuery
 * @param {(p: string) => boolean} hasPermission
 * @param {(moduleKey: string) => boolean} [canAccessModule]
 * @param {{ roleKey?: string, limit?: number }} [opts]
 */
export function filterNavSearchCommands(rawQuery, hasPermission, canAccessModule, opts = {}) {
  const q = String(rawQuery || '').trim().toLowerCase();
  if (q.length < 2) return [];
  const limit = Math.max(1, opts.limit ?? 4);
  const roleKey = String(opts.roleKey || '').trim().toLowerCase();

  const visible = WORKSPACE_NAV_SEARCH_COMMANDS.filter((cmd) => {
    if (cmd.roleKeys?.length && !cmd.roleKeys.includes(roleKey)) return false;
    if (cmd.module && canAccessModule && !canAccessModule(cmd.module)) return false;
    if (cmd.permissions?.length && !cmd.permissions.some((p) => hasPermission(p))) return false;
    return true;
  });

  const hits = [];
  for (const cmd of visible) {
    const blob = [cmd.label, cmd.sublabel, ...(cmd.keywords || [])].join(' ').toLowerCase();
    const score = scoreWorkspaceSearchMatch(q, blob);
    if (score <= 0) continue;
    hits.push({
      kind: 'nav',
      id: cmd.id,
      label: cmd.label,
      sublabel: cmd.sublabel,
      path: cmd.path,
      state: cmd.state,
      _score: score + 50,
    });
  }

  return hits.sort((a, b) => (b._score ?? 0) - (a._score ?? 0)).slice(0, limit);
}

/**
 * Open a sales/transaction search hit as a full record (or manager clearance intel).
 * Branch managers / clearance roles get the same full transaction popup as clear/approval.
 *
 * @param {WorkspaceSearchHit | null | undefined} hit
 * @param {{ openManagerIntel?: boolean }} [opts]
 * @returns {WorkspaceSearchHit | null | undefined}
 */
export function resolveTransactionSearchHit(hit, opts = {}) {
  if (!hit || typeof hit !== 'object') return hit;
  const kind = String(hit.kind || '');
  const id = String(hit.id || '').trim();
  if (!id || !['quotation', 'receipt', 'refund'].includes(kind)) return hit;

  const openManagerIntel = Boolean(opts.openManagerIntel);
  const quoteRef = String(hit.quotationRef || hit.state?.quotationRef || '').trim();

  if (openManagerIntel) {
    if (kind === 'quotation') {
      return {
        ...hit,
        path: `/manager?quoteRef=${encodeURIComponent(id)}`,
        state: undefined,
      };
    }
    if (kind === 'refund') {
      return {
        ...hit,
        path: `/manager?refundId=${encodeURIComponent(id)}`,
        state: undefined,
      };
    }
    if (kind === 'receipt' && quoteRef) {
      return {
        ...hit,
        path: `/manager?quoteRef=${encodeURIComponent(quoteRef)}`,
        state: undefined,
      };
    }
  }

  const type = kind === 'quotation' ? 'quotation' : kind === 'receipt' ? 'receipt' : 'refund';
  const tab = kind === 'quotation' ? 'quotations' : kind === 'receipt' ? 'receipts' : 'refund';
  return {
    ...hit,
    path: '/sales',
    state: {
      focusSalesTab: tab,
      openSalesRecord: { type, id },
      globalSearchQuery: id,
      ...(quoteRef ? { quotationRef: quoteRef } : {}),
    },
  };
}

/**
 * When no dropdown hit is selected, map typed reference prefixes to a sensible route.
 * @param {string} rawQuery
 * @param {{ openManagerIntel?: boolean }} [opts]
 * @returns {{ path: string, state?: object, kind?: string, id?: string } | null}
 */
export function resolveGlobalSearchEnterFallback(rawQuery, opts = {}) {
  const q = String(rawQuery || '').trim();
  const lower = q.toLowerCase();
  if (!lower) return null;
  if (lower.startsWith('qt-') || lower.startsWith('q-')) {
    return resolveTransactionSearchHit(
      { kind: 'quotation', id: q, label: q, path: '/sales' },
      opts
    );
  }
  if (lower.startsWith('rcp-') || lower.startsWith('rcpt')) {
    return resolveTransactionSearchHit(
      { kind: 'receipt', id: q, label: q, path: '/sales' },
      opts
    );
  }
  if (lower.startsWith('rf-')) {
    return resolveTransactionSearchHit(
      { kind: 'refund', id: q, label: q, path: '/sales' },
      opts
    );
  }
  if (lower.startsWith('po-')) {
    return { path: '/procurement', state: { focusTab: 'purchases', globalSearchQuery: q } };
  }
  if (lower.startsWith('pj-') || lower.startsWith('job-')) {
    return { path: '/operations', state: { focusOpsTab: 'production', highlightProductionJobId: q } };
  }
  if (lower.startsWith('del-') || lower.startsWith('dlv-')) {
    return { path: '/operations', state: { focusOpsTab: 'deliveries', globalSearchQuery: q } };
  }
  if (lower.startsWith('exp-')) {
    return { path: '/accounts', state: { accountsTab: 'expenses', highlightExpenseId: q } };
  }
  if (lower.startsWith('pr-') || lower.startsWith('pay-')) {
    return { path: '/accounts', state: { accountsTab: 'payment-requests', highlightPaymentRequestId: q } };
  }
  if (lower.startsWith('cl-')) {
    if (/^cl-\d/i.test(q) || q.split('-').length >= 3) {
      return { path: `/operations/coils/${encodeURIComponent(q)}` };
    }
    return { path: '/operations', state: { focusOpsTab: 'production', highlightCuttingListId: q } };
  }
  return { path: '/sales', state: { globalSearchQuery: q, focusSalesTab: 'customers' } };
}
