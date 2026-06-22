/**
 * Expense category lanes — groups the canonical chart for UX, roles, and policy.
 * Keep aligned with shared/expenseCategoryPolicy.js and expenseCategories.js.
 */

import { EXPENSE_CATEGORY_OPTIONS, isCapexExpenseCategory } from './expenseCategories.js';

/** @typedef {'production'|'logistics'|'admin'|'finance_compliance'|'special'|'capex'|'revenue'|'exception'} ExpenseCategoryLaneKey */

/** @type {Record<ExpenseCategoryLaneKey, { key: ExpenseCategoryLaneKey; label: string; hint: string; sortOrder: number }>} */
export const EXPENSE_CATEGORY_LANE_META = Object.freeze({
  production: {
    key: 'production',
    label: 'Production & factory',
    hint: 'Factory costs, materials, and shop-floor spend.',
    sortOrder: 1,
  },
  logistics: {
    key: 'logistics',
    label: 'Logistics & transport',
    hint: 'Haulage, carriage inward, and delivery costs.',
    sortOrder: 2,
  },
  admin: {
    key: 'admin',
    label: 'Admin & office',
    hint: 'Branch running costs, rent, office, and welfare.',
    sortOrder: 3,
  },
  finance_compliance: {
    key: 'finance_compliance',
    label: 'Finance & compliance',
    hint: 'Bank charges, tax, pension, and interest.',
    sortOrder: 4,
  },
  special: {
    key: 'special',
    label: 'Special — restricted',
    hint: 'Balance-sheet items; Finance / MD only.',
    sortOrder: 5,
  },
  capex: {
    key: 'capex',
    label: 'Fixed assets (capex)',
    hint: 'Capital purchases — creates a fixed asset when fully paid.',
    sortOrder: 6,
  },
  revenue: {
    key: 'revenue',
    label: 'Revenue / contra',
    hint: 'Not for payment requests — use Refund or revenue modules.',
    sortOrder: 7,
  },
  exception: {
    key: 'exception',
    label: 'Other (exception)',
    hint: 'Last resort — requires explanation and supporting document.',
    sortOrder: 8,
  },
});

/** @type {Record<string, ExpenseCategoryLaneKey>} */
const CATEGORY_TO_LANE = Object.freeze({
  Purchases: 'production',
  Accessories: 'production',
  'Production cost': 'production',
  Wages: 'production',
  'Fuel & lubricant': 'production',
  'Outside corrugation': 'production',
  Maintenance: 'production',
  Depreciation: 'production',
  'Carriage inward': 'logistics',
  'Truck & mining': 'logistics',
  'Admin expenses': 'admin',
  'Admin salary': 'admin',
  'Rent & utilities': 'admin',
  'Office expenses': 'admin',
  'IT & software': 'admin',
  Insurance: 'admin',
  'Professional fees': 'admin',
  Security: 'admin',
  Welfare: 'admin',
  'Zakat & Sallah': 'admin',
  'Marketing & advertising': 'admin',
  HQ: 'special',
  'Bank charges': 'finance_compliance',
  Tax: 'finance_compliance',
  Pension: 'finance_compliance',
  Interest: 'finance_compliance',
  'Staff loan': 'special',
  'Chairman withdrawal': 'special',
  'Closing stock': 'special',
  Sales: 'revenue',
  Refund: 'revenue',
  'Net sales': 'revenue',
  Others: 'exception',
  Miscellaneous: 'exception',
  'Land and buildings': 'capex',
  'Plant and machinery': 'capex',
  'Furniture & fittings': 'capex',
  Generator: 'capex',
});

export const RESTRICTED_EXPENSE_LANE_KEYS = Object.freeze(['special', 'capex', 'revenue']);

export const ELEVATED_APPROVAL_LANE_KEYS = Object.freeze(['special', 'capex', 'exception']);

/** @param {string} category */
export function getExpenseCategoryLane(category) {
  const cat = String(category || '').trim();
  if (CATEGORY_TO_LANE[cat]) return CATEGORY_TO_LANE[cat];
  if (isCapexExpenseCategory(cat)) return 'capex';
  return 'exception';
}

/** @param {ExpenseCategoryLaneKey} laneKey */
export function getExpenseCategoryLaneMeta(laneKey) {
  return EXPENSE_CATEGORY_LANE_META[laneKey] || EXPENSE_CATEGORY_LANE_META.exception;
}

export function groupExpenseCategoriesByLane() {
  /** @type {Record<ExpenseCategoryLaneKey, string[]>} */
  const groups = {};
  for (const key of Object.keys(EXPENSE_CATEGORY_LANE_META)) {
    groups[key] = [];
  }
  for (const cat of EXPENSE_CATEGORY_OPTIONS) {
    const lane = getExpenseCategoryLane(cat);
    groups[lane].push(cat);
  }
  return Object.entries(EXPENSE_CATEGORY_LANE_META)
    .sort((a, b) => a[1].sortOrder - b[1].sortOrder)
    .map(([laneKey, meta]) => ({
      laneKey,
      label: meta.label,
      hint: meta.hint,
      categories: groups[laneKey] || [],
    }))
    .filter((g) => g.categories.length > 0);
}

/** @param {string} category */
export function isExceptionExpenseCategory(category) {
  return getExpenseCategoryLane(category) === 'exception';
}

/** @param {string} category */
export function isRevenueExpenseCategory(category) {
  return getExpenseCategoryLane(category) === 'revenue';
}

/** @param {string} category */
export function requiresElevatedApprovalLane(category) {
  return ELEVATED_APPROVAL_LANE_KEYS.includes(getExpenseCategoryLane(category));
}

/** UI badge metadata per lane (Finance desk + manager inbox). */
export const EXPENSE_CATEGORY_LANE_BADGE = Object.freeze({
  production: { label: 'Production', className: 'bg-teal-100 text-teal-900 ring-1 ring-teal-200/80' },
  logistics: { label: 'Logistics', className: 'bg-sky-100 text-sky-900 ring-1 ring-sky-200/80' },
  admin: { label: 'Admin', className: 'bg-slate-100 text-slate-800 ring-1 ring-slate-200/80' },
  finance_compliance: { label: 'Finance', className: 'bg-indigo-100 text-indigo-900 ring-1 ring-indigo-200/80' },
  special: { label: 'Special', className: 'bg-rose-100 text-rose-900 ring-1 ring-rose-200/80' },
  capex: { label: 'Capex', className: 'bg-violet-100 text-violet-900 ring-1 ring-violet-200/80' },
  revenue: { label: 'Revenue', className: 'bg-gray-100 text-gray-700 ring-1 ring-gray-200/80' },
  exception: { label: 'Exception', className: 'bg-amber-100 text-amber-950 ring-1 ring-amber-200/80' },
});

/**
 * @param {string} category
 * @param {string} [laneKey]
 */
export function expenseCategoryLaneBadge(category, laneKey) {
  const lane = laneKey || getExpenseCategoryLane(category);
  return EXPENSE_CATEGORY_LANE_BADGE[lane] || EXPENSE_CATEGORY_LANE_BADGE.exception;
}
