/**
 * ERP-native workspace category registry for work items and inbox filtering.
 * Shared between backend mappers and frontend inbox UI.
 * Frontend copies via `npm run sync:shared` → src/shared/lib/workspaceCategoryRegistry.js
 */

/** @typedef {'all'|'sales'|'finance'|'procurement'|'production'|'inventory'|'operations'|'management'|'hr_admin'|'memos'|'system_alerts'} WorkspaceCategoryKey */

/** @type {Record<Exclude<WorkspaceCategoryKey,'all'>, { key: string, label: string, description: string, emptyMessage: string, colorClass: string, documentTypes: string[], documentClasses: string[], sourceKinds: string[] }>} */
export const WORKSPACE_CATEGORIES = {
  sales: {
    key: 'sales',
    label: 'Sales',
    description: 'Quotations, clearance, and customer-facing approvals',
    emptyMessage: 'No sales items in this view.',
    colorClass: 'bg-sky-50 text-sky-900 ring-sky-100',
    documentTypes: ['quotation_clearance', 'conversion_review'],
    documentClasses: [],
    sourceKinds: [],
  },
  finance: {
    key: 'finance',
    label: 'Finance',
    description: 'Payment requests, refunds, treasury, and bank reconciliation',
    emptyMessage: 'No finance items in this view.',
    colorClass: 'bg-emerald-50 text-emerald-900 ring-emerald-100',
    documentTypes: [
      'payment_request',
      'refund_request',
      'bank_recon_exceptions',
      'po_transport_payment',
      'collections_followup',
    ],
    documentClasses: [],
    sourceKinds: [],
  },
  procurement: {
    key: 'procurement',
    label: 'Procurement',
    description: 'Purchase orders, supplier issues, and transport payments',
    emptyMessage: 'No procurement items in this view.',
    colorClass: 'bg-violet-50 text-violet-900 ring-violet-100',
    documentTypes: ['coil_grn_short_receipt', 'in_transit_load'],
    documentClasses: [],
    sourceKinds: [],
  },
  production: {
    key: 'production',
    label: 'Production',
    description: 'Production gates, jobs, and shop-floor handovers',
    emptyMessage: 'No production items in this view.',
    colorClass: 'bg-amber-50 text-amber-900 ring-amber-100',
    documentTypes: ['production_gate'],
    documentClasses: [],
    sourceKinds: [],
  },
  inventory: {
    key: 'inventory',
    label: 'Inventory',
    description: 'Material requests, coil issues, and stock exceptions',
    emptyMessage: 'No inventory items in this view.',
    colorClass: 'bg-orange-50 text-orange-900 ring-orange-100',
    documentTypes: ['material_request', 'material_incident'],
    documentClasses: [],
    sourceKinds: ['coil_request'],
  },
  operations: {
    key: 'operations',
    label: 'Operations',
    description: 'Maintenance, machine incidents, and operational reports',
    emptyMessage: 'No operations items in this view.',
    colorClass: 'bg-teal-50 text-teal-900 ring-teal-100',
    documentTypes: ['machine_incident', 'maintenance_work_order', 'maintenance_plan'],
    documentClasses: ['report'],
    sourceKinds: [],
  },
  management: {
    key: 'management',
    label: 'Management',
    description: 'Governance, flagged transactions, and edit approvals',
    emptyMessage: 'No management items in this view.',
    colorClass: 'bg-indigo-50 text-indigo-900 ring-indigo-100',
    documentTypes: ['flagged_transaction', 'edit_approval'],
    documentClasses: ['approval'],
    sourceKinds: [],
  },
  hr_admin: {
    key: 'hr_admin',
    label: 'HR/Admin',
    description: 'HR requests, performance reviews, and admin correspondence',
    emptyMessage: 'No HR or admin items in this view.',
    colorClass: 'bg-slate-100 text-slate-800 ring-slate-200',
    documentTypes: ['performance_review'],
    documentClasses: [],
    sourceKinds: ['hr_request'],
  },
  memos: {
    key: 'memos',
    label: 'Memos',
    description: 'Internal official correspondence and memo threads',
    emptyMessage: 'No memos in this view. Compose an internal memo to start a thread.',
    colorClass: 'bg-teal-50 text-teal-950 ring-teal-100',
    documentTypes: ['memo'],
    documentClasses: ['correspondence', 'request', 'report', 'approval'],
    sourceKinds: ['office_thread'],
  },
  system_alerts: {
    key: 'system_alerts',
    label: 'System Alerts',
    description: 'System-generated attention items and workflow exceptions',
    emptyMessage: 'No system alerts in this view.',
    colorClass: 'bg-rose-50 text-rose-900 ring-rose-100',
    documentTypes: [],
    documentClasses: [],
    sourceKinds: [],
  },
};

/** @type {WorkspaceCategoryKey[]} */
export const WORKSPACE_CATEGORY_ORDER = [
  'all',
  'sales',
  'finance',
  'procurement',
  'production',
  'inventory',
  'operations',
  'management',
  'hr_admin',
  'memos',
  'system_alerts',
];

/** @type {Record<WorkspaceCategoryKey, string>} */
export const WORKSPACE_CATEGORY_LABELS = Object.fromEntries(
  WORKSPACE_CATEGORY_ORDER.map((key) => [key, key === 'all' ? 'All' : WORKSPACE_CATEGORIES[key]?.label || key])
);

/**
 * @param {Record<string, unknown>|null|undefined} item
 * @returns {Exclude<WorkspaceCategoryKey,'all'>}
 */
export function categoryForWorkItem(item) {
  const dt = String(item?.documentType || '').trim().toLowerCase();
  const sk = String(item?.sourceKind || '').trim().toLowerCase();
  const dc = String(item?.documentClass || '').trim().toLowerCase();

  if (sk === 'office_thread' || String(item?.linkedThreadId || '').trim()) return 'memos';
  if (dc === 'correspondence' || dt === 'memo') return 'memos';

  if (dt.startsWith('hr_') || sk === 'hr_request') return 'hr_admin';

  for (const key of WORKSPACE_CATEGORY_ORDER) {
    if (key === 'all') continue;
    const cat = WORKSPACE_CATEGORIES[key];
    if (!cat) continue;
    if (cat.documentTypes.includes(dt)) return key;
    if (cat.sourceKinds.includes(sk)) return key;
    if (dc && cat.documentClasses.includes(dc)) return key;
  }

  if (item?.legacy && !dt) return 'system_alerts';
  return 'operations';
}

/**
 * @param {Record<string, unknown>|null|undefined} item
 * @returns {typeof WORKSPACE_CATEGORIES[keyof typeof WORKSPACE_CATEGORIES]}
 */
export function categoryMetaForWorkItem(item) {
  const key = categoryForWorkItem(item);
  return WORKSPACE_CATEGORIES[key] || WORKSPACE_CATEGORIES.operations;
}

/**
 * @param {Record<string, unknown>|null|undefined} item
 * @param {WorkspaceCategoryKey} categoryKey
 */
export function workItemMatchesCategory(item, categoryKey) {
  if (categoryKey === 'all') return true;
  return categoryForWorkItem(item) === categoryKey;
}

/** @deprecated Use categoryForWorkItem — kept for legacy mailTab callers */
export function mailTabForWorkItem(item) {
  const cat = categoryForWorkItem(item);
  const legacyMap = {
    sales: 'sales',
    finance: 'finance',
    procurement: 'procurement',
    production: 'production',
    inventory: 'inventory',
    operations: 'operations',
    management: 'management',
    hr_admin: 'hr_admin',
    memos: 'memos',
    system_alerts: 'system_alerts',
  };
  return legacyMap[cat] || 'operations';
}

export const MAIL_TAB_ORDER = WORKSPACE_CATEGORY_ORDER;
export const MAIL_TAB_LABELS = WORKSPACE_CATEGORY_LABELS;
