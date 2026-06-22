/**
 * Expense category → GL account code (paid-on-payment recognition).
 * Keep aligned with server accountingPostingOps and Accounting Desk UX labels.
 */
import { isCapexExpenseCategory, capexExpenseAssetMeta } from '../expenseCategories.js';

/** @type {Record<string, string>} */
const CATEGORY_TO_GL = Object.freeze({
  Wages: '6000',
  'Fuel & lubricant': '5010',
  Maintenance: '5020',
  'Outside corrugation': '5030',
  'Production cost': '5040',
  'Carriage inward': '5050',
  Purchases: '5050',
  Accessories: '5040',
  'Admin salary': '6110',
  'Admin expenses': '6120',
  'Office expenses': '6120',
  'Rent & utilities': '6130',
  'IT & software': '6140',
  Insurance: '6150',
  'Professional fees': '6160',
  'Bank charges': '6170',
  Interest: '6300',
  'Marketing & advertising': '6400',
  HQ: '6120',
  Welfare: '6120',
  Security: '6120',
  Tax: '6160',
  'Zakat & Sallah': '6180',
  Pension: '2400',
  'Truck & mining': '5050',
  'Staff loan': '1200',
  'Chairman withdrawal': '3200',
  Depreciation: '6100',
  Sales: '4000',
  Refund: '2500',
  'Net sales': '4000',
  'Closing stock': '1300',
  Others: '6120',
  Miscellaneous: '6120',
});

const DEFAULT_EXPENSE_GL = '6120';

/**
 * @param {string} category
 * @param {{ capexAsAsset?: boolean }} [opts]
 * @returns {{ accountCode: string; isEquity: boolean; isCapex: boolean }}
 */
export function glAccountForExpenseCategory(category, opts = {}) {
  const cat = String(category || '').trim();
  if (isCapexExpenseCategory(cat) && opts.capexAsAsset !== false) {
    const meta = capexExpenseAssetMeta(cat);
    return { accountCode: meta.glAccountCode, isEquity: false, isCapex: true };
  }
  if (cat === 'Chairman withdrawal') {
    return { accountCode: '3200', isEquity: true, isCapex: false };
  }
  const code = CATEGORY_TO_GL[cat] || DEFAULT_EXPENSE_GL;
  return { accountCode: code, isEquity: code === '3200', isCapex: false };
}

export function listExpenseCategoryGlMappings() {
  return Object.entries(CATEGORY_TO_GL).map(([category, accountCode]) => ({ category, accountCode }));
}
