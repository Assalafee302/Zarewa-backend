/**
 * Smart Memo Composer — rule-based memo type detection, routing, and workflow hints.
 * Shared between backend and frontend (keep frontend copy in sync).
 */

export const SMART_MEMO_TYPES = {
  maintenance_repairs: {
    key: 'maintenance_repairs',
    label: 'Maintenance / Repairs',
    filingCategory: 'Maintenance',
    defaultOfficeKey: 'branch_manager',
    defaultPriority: 'high',
    conversionTargets: ['expense', 'procurement'],
    keywords: [
      /\brepair(s|ed)?\b/i,
      /\bmaintenance\b/i,
      /\bmechanic\b/i,
      /\bservice(d|ing)?\b/i,
      /\bbroken\b/i,
      /\bfault(y)?\b/i,
      /\bmachine\b/i,
      /\bequipment\b/i,
      /\bgen(erator)?\b/i,
      /\bplant\b/i,
    ],
    expenseCategory: 'Maintenance',
    nextAction: 'Route to Branch Manager or Operations for assessment and vendor quotation.',
    requiredAttachments: ['Photo of fault', 'Mechanic/vendor quotation if available'],
  },
  fuel_diesel: {
    key: 'fuel_diesel',
    label: 'Fuel / Diesel Request',
    filingCategory: 'Fuel & Power',
    defaultOfficeKey: 'branch_manager',
    defaultPriority: 'urgent',
    conversionTargets: ['expense'],
    keywords: [
      /\bdiesel\b/i,
      /\bfuel\b/i,
      /\bpetrol\b/i,
      /\bno\s+diesel\b/i,
      /\bout\s+of\s+fuel\b/i,
      /\bgenerator\s+fuel\b/i,
    ],
    expenseCategory: 'Fuel & lubricant',
    nextAction: 'Seek Branch Manager approval to purchase fuel for generator/vehicle.',
    requiredAttachments: ['Estimated litres and cost', 'Vendor/station name if known'],
  },
  procurement_request: {
    key: 'procurement_request',
    label: 'Procurement Request',
    filingCategory: 'Procurement',
    defaultOfficeKey: 'procurement',
    defaultPriority: 'normal',
    conversionTargets: ['procurement', 'expense'],
    keywords: [
      /\bprocure(ment)?\b/i,
      /\bpurchase\b/i,
      /\bbuy\b/i,
      /\bsupplier\b/i,
      /\bquotation\b/i,
      /\bitems?\s+(needed|required|list)\b/i,
      /\bspare\s+parts?\b/i,
      /\bmaterials?\s+(short|needed)\b/i,
    ],
    expenseCategory: 'Purchases',
    nextAction: 'Attach item list and route to Procurement office.',
    requiredAttachments: ['Item list with quantities', 'Supplier quotation if available'],
  },
  expense_support: {
    key: 'expense_support',
    label: 'Expense Request Support Memo',
    filingCategory: 'Finance Requests',
    defaultOfficeKey: 'finance',
    defaultPriority: 'normal',
    conversionTargets: ['expense'],
    keywords: [
      /\bexpense\b/i,
      /\breimburs(e|ement)\b/i,
      /\bpay(ment)?\s+(needed|required)\b/i,
      /\bcashier\b/i,
      /\bamount\b/i,
    ],
    expenseCategory: 'Others',
    nextAction: 'Convert to expense request after manager approval.',
    requiredAttachments: ['Supporting receipt or invoice'],
  },
  production_issue: {
    key: 'production_issue',
    label: 'Production Issue Report',
    filingCategory: 'Production Issues',
    defaultOfficeKey: 'operations',
    defaultPriority: 'high',
    conversionTargets: ['procurement', 'expense'],
    keywords: [
      /\bproduction\b/i,
      /\bdowntime\b/i,
      /\bdelay(ed)?\b/i,
      /\bline\s+(stop|down)\b/i,
      /\bshop\s*floor\b/i,
      /\boutput\b/i,
    ],
    expenseCategory: 'Maintenance',
    nextAction: 'Notify Operations and attach impact on production schedule.',
    requiredAttachments: ['Production job reference if applicable', 'Photo of issue'],
  },
  operations_incident: {
    key: 'operations_incident',
    label: 'Operations Incident Report',
    filingCategory: 'Operations',
    defaultOfficeKey: 'operations',
    defaultPriority: 'high',
    conversionTargets: ['expense', 'procurement'],
    keywords: [
      /\bincident\b/i,
      /\baccident\b/i,
      /\bsafety\b/i,
      /\bemergency\b/i,
      /\bbranch\s+(issue|problem)\b/i,
    ],
    expenseCategory: 'Others',
    nextAction: 'Report to Operations office with location and immediate impact.',
    requiredAttachments: ['Incident description', 'Photos if applicable'],
  },
  finance_payment: {
    key: 'finance_payment',
    label: 'Finance / Payment Request',
    filingCategory: 'Finance Requests',
    defaultOfficeKey: 'finance',
    defaultPriority: 'normal',
    conversionTargets: ['expense'],
    keywords: [
      /\bpayment\s+request\b/i,
      /\brefund\b/i,
      /\btreasury\b/i,
      /\bfinance\b/i,
      /\bpayout\b/i,
    ],
    expenseCategory: 'Others',
    nextAction: 'Route to Finance after Branch Manager clearance.',
    requiredAttachments: ['Amount and beneficiary', 'Approval reference if any'],
  },
  hr_admin: {
    key: 'hr_admin',
    label: 'HR / Admin Memo',
    filingCategory: 'HR/Admin',
    defaultOfficeKey: 'hr',
    defaultPriority: 'normal',
    conversionTargets: [],
    keywords: [/\bhr\b/i, /\bstaff\b/i, /\bleave\b/i, /\badmin\b/i, /\bpersonnel\b/i],
    expenseCategory: null,
    nextAction: 'Route to HR/Admin office.',
    requiredAttachments: [],
  },
  management_approval: {
    key: 'management_approval',
    label: 'Management Approval Request',
    filingCategory: 'Management Approvals',
    defaultOfficeKey: 'branch_manager',
    defaultPriority: 'normal',
    conversionTargets: ['expense'],
    keywords: [
      /\bapproval\b/i,
      /\bapprove\b/i,
      /\bmd\b/i,
      /\bmanagement\b/i,
      /\bceo\b/i,
      /\bescalat(e|ion)\b/i,
    ],
    expenseCategory: 'Others',
    nextAction: 'Seek management approval before finance action.',
    requiredAttachments: ['Clear justification and amount if applicable'],
  },
  general_internal: {
    key: 'general_internal',
    label: 'General Internal Memo',
    filingCategory: 'General Correspondence',
    defaultOfficeKey: 'office_admin',
    defaultPriority: 'normal',
    conversionTargets: [],
    keywords: [],
    expenseCategory: null,
    nextAction: 'Send to appropriate recipients.',
    requiredAttachments: [],
  },
};

/** Guided field schemas per memo type */
export const SMART_MEMO_GUIDED_FIELDS = {
  maintenance_repairs: [
    { key: 'equipmentAffected', label: 'Equipment affected', type: 'text', required: true },
    { key: 'faultDescription', label: 'Fault description', type: 'text', required: true },
    { key: 'location', label: 'Location / branch area', type: 'text', required: false },
    { key: 'urgency', label: 'Urgency', type: 'select', options: ['normal', 'high', 'urgent'], required: true },
    { key: 'workStopped', label: 'Is production affected?', type: 'select', options: ['yes', 'no', 'partial'], required: false },
    { key: 'mechanicVendor', label: 'Mechanic / vendor name', type: 'text', required: false },
    { key: 'estimatedCostNgn', label: 'Estimated cost (NGN)', type: 'number', required: false },
    { key: 'requiredParts', label: 'Required parts / items', type: 'text', required: false },
  ],
  fuel_diesel: [
    { key: 'fuelType', label: 'Fuel type', type: 'select', options: ['diesel', 'petrol', 'other'], required: true },
    { key: 'quantityLitres', label: 'Quantity (litres)', type: 'number', required: true },
    { key: 'equipment', label: 'Generator / vehicle / equipment', type: 'text', required: true },
    { key: 'currentImpact', label: 'Current impact on operations', type: 'text', required: true },
    { key: 'estimatedCostNgn', label: 'Estimated cost (NGN)', type: 'number', required: false },
    { key: 'vendorStation', label: 'Vendor / station', type: 'text', required: false },
    { key: 'urgency', label: 'Urgency', type: 'select', options: ['normal', 'high', 'urgent'], required: true },
  ],
  procurement_request: [
    { key: 'itemList', label: 'Item list (one per line)', type: 'textarea', required: true },
    { key: 'purpose', label: 'Purpose', type: 'text', required: true },
    { key: 'department', label: 'Department / branch', type: 'text', required: false },
    { key: 'estimatedCostNgn', label: 'Estimated total cost (NGN)', type: 'number', required: false },
    { key: 'supplierVendor', label: 'Supplier / vendor', type: 'text', required: false },
    { key: 'requiredDate', label: 'Required by date', type: 'date', required: false },
  ],
  expense_support: [
    { key: 'expensePurpose', label: 'Expense purpose', type: 'text', required: true },
    { key: 'amountNgn', label: 'Amount (NGN)', type: 'number', required: true },
    { key: 'beneficiary', label: 'Beneficiary / vendor', type: 'text', required: true },
    { key: 'paymentUrgency', label: 'Payment urgency', type: 'select', options: ['normal', 'high', 'urgent'], required: false },
  ],
  production_issue: [
    { key: 'productionJobRef', label: 'Production job / reference', type: 'text', required: false },
    { key: 'machineLine', label: 'Machine / line affected', type: 'text', required: true },
    { key: 'issueDescription', label: 'Issue description', type: 'text', required: true },
    { key: 'productionImpact', label: 'Impact on production', type: 'text', required: true },
    { key: 'requiredAction', label: 'Required action', type: 'text', required: false },
    { key: 'urgency', label: 'Urgency', type: 'select', options: ['normal', 'high', 'urgent'], required: true },
  ],
};

export const MANAGER_REPLY_TEMPLATES = [
  {
    id: 'approve_proceed',
    label: 'Approved — proceed',
    body: 'Approved. Please proceed and attach the mechanic/vendor quotation for payment processing.',
  },
  {
    id: 'need_cost',
    label: 'Need estimated cost',
    body: 'Please provide the estimated cost, beneficiary/vendor name, and urgency before this can be approved.',
  },
  {
    id: 'call_mechanic',
    label: 'Call mechanic — upload list',
    body: 'Please call the mechanic/vendor and upload the item list or quotation as supporting documents.',
  },
  {
    id: 'forward_finance',
    label: 'Forwarding to Finance',
    body: 'Forwarding to Finance for payment review. Finance will advise on clearance and payout timing.',
  },
  {
    id: 'reject_incomplete',
    label: 'Rejected — incomplete',
    body: 'This memo cannot be approved yet because key details are missing. Please update with equipment, fault, and estimated cost.',
  },
  {
    id: 'escalate_ops',
    label: 'Escalating to Operations',
    body: 'Escalating to Operations/HQ for technical assessment. You will receive a follow-up in this thread.',
  },
];

/**
 * @param {string} subject
 * @param {string} body
 */
export function detectSmartMemoType(subject = '', body = '') {
  const text = `${subject}\n${body}`.trim();
  if (!text) return 'general_internal';

  let best = { key: 'general_internal', score: 0 };
  for (const [key, meta] of Object.entries(SMART_MEMO_TYPES)) {
    if (key === 'general_internal') continue;
    let score = 0;
    for (const re of meta.keywords) {
      if (re.test(text)) score += 2;
    }
    if (score > best.score) best = { key, score };
  }
  return best.key;
}

/**
 * @param {{ subject?: string, body?: string, memoType?: string, attachmentCount?: number }} input
 */
export function buildSmartMemoSuggestions(input = {}) {
  const subject = String(input.subject || '');
  const body = String(input.body || '');
  const memoType = input.memoType || detectSmartMemoType(subject, body);
  const meta = SMART_MEMO_TYPES[memoType] || SMART_MEMO_TYPES.general_internal;
  const guidedFieldDefs = SMART_MEMO_GUIDED_FIELDS[memoType] || [];

  const checklist = buildSmartMemoChecklist(memoType, input.guidedFields || {}, input.attachmentCount ?? 0);

  return {
    memoType,
    memoTypeLabel: meta.label,
    responsibleOfficeKey: meta.defaultOfficeKey,
    responsibleOfficeLabel: officeKeyLabel(meta.defaultOfficeKey),
    priority: meta.defaultPriority,
    filingCategory: meta.filingCategory,
    expenseCategory: meta.expenseCategory,
    conversionTargets: meta.conversionTargets,
    nextAction: meta.nextAction,
    suggestedAttachments: meta.requiredAttachments,
    guidedFieldDefs,
    checklist,
    runaHints: buildRunaHints(memoType, meta, checklist),
  };
}

function officeKeyLabel(key) {
  const map = {
    office_admin: 'Office administration',
    branch_manager: 'Branch manager',
    sales: 'Sales office',
    procurement: 'Procurement office',
    operations: 'Operations office',
    finance: 'Finance office',
    hr: 'HR office',
  };
  return map[key] || key;
}

/**
 * @param {string} memoType
 * @param {Record<string, string>} guidedFields
 * @param {number} attachmentCount
 */
export function buildSmartMemoChecklist(memoType, guidedFields = {}, attachmentCount = 0) {
  const meta = SMART_MEMO_TYPES[memoType] || SMART_MEMO_TYPES.general_internal;
  const defs = SMART_MEMO_GUIDED_FIELDS[memoType] || [];
  /** @type {{ id: string, label: string, satisfied: boolean, required: boolean }[]} */
  const items = [];

  for (const f of defs) {
    const val = String(guidedFields[f.key] ?? '').trim();
    items.push({
      id: f.key,
      label: f.label,
      satisfied: Boolean(val),
      required: Boolean(f.required),
    });
  }

  if (meta.requiredAttachments?.length) {
    items.push({
      id: 'attachments',
      label: 'Supporting documents attached',
      satisfied: attachmentCount > 0,
      required: memoType === 'procurement_request' || memoType === 'expense_support',
    });
  }

  const missingRequired = items.filter((i) => i.required && !i.satisfied);
  const warning =
    missingRequired.length > 0
      ? `This memo may be difficult to approve because ${missingRequired.map((m) => m.label.toLowerCase()).join(', ')} ${missingRequired.length === 1 ? 'is' : 'are'} missing.`
      : null;

  return { items, missingRequired, warning, complete: missingRequired.length === 0 };
}

function buildRunaHints(memoType, meta, checklist) {
  const hints = [`This looks like a ${meta.label} memo.`];
  if (meta.expenseCategory) {
    hints.push(`Suggested expense category: ${meta.expenseCategory}.`);
  }
  if (meta.conversionTargets.includes('expense')) {
    hints.push('If payment is involved, it should go through Branch Manager approval before Finance.');
  }
  if (checklist.warning) hints.push(checklist.warning);
  return hints;
}

/**
 * Rule-based memo improvement when AI is unavailable.
 * @param {string} subject
 * @param {string} body
 * @param {string} [memoType]
 */
export function improveMemoRuleBased(subject = '', body = '', memoType) {
  const type = memoType || detectSmartMemoType(subject, body);
  const meta = SMART_MEMO_TYPES[type] || SMART_MEMO_TYPES.general_internal;
  const rawSub = String(subject || '').trim();
  const rawBody = String(body || '').trim();

  let newSubject = rawSub;
  if (!newSubject || newSubject.length < 8) {
    newSubject = `${meta.label}${rawSub ? `: ${rawSub}` : ''}`.slice(0, 120);
  }
  if (meta.defaultPriority === 'urgent' && !/urgent/i.test(newSubject)) {
    newSubject = `Urgent: ${newSubject}`.slice(0, 120);
  }

  const lines = [];
  if (rawBody) {
    const cleaned = rawBody.replace(/\s+/g, ' ').trim();
    lines.push(cleaned.endsWith('.') ? cleaned : `${cleaned}.`);
  } else {
    lines.push(`This memo relates to ${meta.label.toLowerCase()} and requires attention from ${officeKeyLabel(meta.defaultOfficeKey)}.`);
  }
  lines.push('');
  lines.push('Requested action:');
  lines.push(meta.nextAction);

  return { subject: newSubject, body: lines.join('\n') };
}

/**
 * @param {string} memoType
 * @param {string[]} permissions
 */
export function canConvertMemoToExpense(memoType, permissions = []) {
  const meta = SMART_MEMO_TYPES[memoType] || SMART_MEMO_TYPES.general_internal;
  if (!meta.conversionTargets.includes('expense')) return false;
  return (
    permissions.includes('*') ||
    permissions.includes('office.use') ||
    permissions.includes('expenses.create') ||
    permissions.includes('finance.post')
  );
}

/**
 * @param {string} memoType
 * @param {string[]} permissions
 */
export function canConvertMemoToProcurement(memoType, permissions = []) {
  const meta = SMART_MEMO_TYPES[memoType] || SMART_MEMO_TYPES.general_internal;
  if (!meta.conversionTargets.includes('procurement')) return false;
  return (
    permissions.includes('*') ||
    permissions.includes('office.use') ||
    permissions.includes('operations.manage') ||
    permissions.includes('production.manage')
  );
}

/**
 * Parse item list text into material request lines.
 * @param {string} itemListText
 */
export function parseItemListToMaterialLines(itemListText) {
  const lines = String(itemListText || '')
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.map((line, idx) => {
    const m = line.match(/^(.+?)\s*[x×]\s*(\d+(?:\.\d+)?)\s*(.*)?$/i);
    if (m) {
      return {
        lineNo: idx + 1,
        itemName: m[1].trim(),
        qtyRequested: Number(m[2]) || 1,
        unit: (m[3] || 'unit').trim() || 'unit',
      };
    }
    return { lineNo: idx + 1, itemName: line, qtyRequested: 1, unit: 'unit' };
  });
}

/**
 * Build smartMemo payload for thread create.
 * @param {object} params
 */
export function buildSmartMemoPayload(params) {
  return {
    smartMemo: {
      memoType: params.memoType,
      priority: params.priority,
      filingCategory: params.filingCategory,
      expenseCategory: params.expenseCategory || null,
      guidedFields: params.guidedFields || {},
      filingStatus: 'needs_filing',
      detectedAtIso: new Date().toISOString(),
    },
  };
}
