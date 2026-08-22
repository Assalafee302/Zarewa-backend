/**
 * Register-first accounting: which module owns each GL control account at cutover and ongoing.
 * Used by Opening Pack builders and control tie-out (see docs/ACCOUNTING_SYSTEM_ARCHITECTURE.md).
 * Frontend copies via `npm run sync:shared` → src/shared/lib/accountingSourceOfTruth.js
 */

/** @typedef {'creditors' | 'debtors' | 'fixed_assets' | 'stock_register' | 'treasury' | 'inter_branch' | 'payroll' | 'ap2_diagnostic' | 'manual' | 'computed'} AccountingSourceModule */

/**
 * @typedef {{
 *   glAccountCode: string;
 *   name: string;
 *   primaryModule: AccountingSourceModule;
 *   registerSection?: string;
 *   cutoverMethod: string;
 *   allowManualOpeningLine: boolean;
 *   drillDownTab?: string;
 * }} GlSourceMapping
 */

/** @type {GlSourceMapping[]} */
export const GL_SOURCE_OF_TRUTH = [
  {
    glAccountCode: '1001',
    name: 'Cash — per bank (1001, 1002, …)',
    primaryModule: 'treasury',
    cutoverMethod: 'Treasury balance per account after reconciliation sign-off',
    allowManualOpeningLine: false,
    drillDownTab: 'reconciliation',
  },
  {
    glAccountCode: '1200',
    name: 'Trade receivable',
    primaryModule: 'creditors',
    registerSection: 'customer_receivables',
    cutoverMethod: 'Creditors register total + legacy inherited lines',
    allowManualOpeningLine: false,
    drillDownTab: 'creditors',
  },
  {
    glAccountCode: '1300',
    name: 'Raw materials inventory',
    primaryModule: 'stock_register',
    cutoverMethod: 'Prior month stock register closing after procurement costing',
    allowManualOpeningLine: false,
    drillDownTab: 'reports',
  },
  {
    glAccountCode: '1398',
    name: 'Accumulated depreciation',
    primaryModule: 'fixed_assets',
    cutoverMethod: 'Optional opening acc dep from fixed asset register; monthly depreciation runs thereafter',
    allowManualOpeningLine: false,
    drillDownTab: 'assets',
  },
  {
    glAccountCode: '1400',
    name: 'Supplier prepayments',
    primaryModule: 'creditors',
    registerSection: 'supplier_prepayments',
    cutoverMethod: 'Creditors register — paid before GRN',
    allowManualOpeningLine: false,
    drillDownTab: 'creditors',
  },
  {
    glAccountCode: '1500',
    name: 'Plant & machinery (1500–1504 by category)',
    primaryModule: 'fixed_assets',
    cutoverMethod: 'Sum fixed asset cost by category and branch',
    allowManualOpeningLine: false,
    drillDownTab: 'assets',
  },
  {
    glAccountCode: '1800',
    name: 'Due from branch',
    primaryModule: 'inter_branch',
    registerSection: 'inter_branch_receivable',
    cutoverMethod: 'Inter-branch loan balances + creditors section',
    allowManualOpeningLine: false,
    drillDownTab: 'interBranch',
  },
  {
    glAccountCode: '2000',
    name: 'Trade payables',
    primaryModule: 'debtors',
    registerSection: 'supplier_payables',
    cutoverMethod: 'Debtors register AP + legacy lines',
    allowManualOpeningLine: false,
    drillDownTab: 'debtors',
  },
  {
    glAccountCode: '2100',
    name: 'GRNI',
    primaryModule: 'ap2_diagnostic',
    cutoverMethod: 'AP2 inventory/GL alignment diagnostic; manual only if immaterial gap',
    allowManualOpeningLine: true,
    drillDownTab: 'debtors',
  },
  {
    glAccountCode: '2150',
    name: 'Bank suspense',
    primaryModule: 'debtors',
    registerSection: 'bank_deposit_suspense',
    cutoverMethod: 'Debtors unallocated receipts / suspense',
    allowManualOpeningLine: false,
    drillDownTab: 'debtors',
  },
  {
    glAccountCode: '2200',
    name: 'Payroll liabilities (2200–2400)',
    primaryModule: 'payroll',
    cutoverMethod: 'Accrued amounts from locked/unpaid payroll runs at cutover',
    allowManualOpeningLine: false,
    drillDownTab: 'payroll',
  },
  {
    glAccountCode: '2500',
    name: 'Customer deposits',
    primaryModule: 'debtors',
    registerSection: 'customer_deposits',
    cutoverMethod: 'Debtors deposits + pre-production deposit sections',
    allowManualOpeningLine: false,
    drillDownTab: 'debtors',
  },
  {
    glAccountCode: '2800',
    name: 'Due to branch',
    primaryModule: 'inter_branch',
    registerSection: 'inter_branch_payable',
    cutoverMethod: 'Inter-branch loan balances + debtors section',
    allowManualOpeningLine: false,
    drillDownTab: 'interBranch',
  },
  {
    glAccountCode: '3100',
    name: "Owner's capital",
    primaryModule: 'manual',
    cutoverMethod: 'HoA enters from last audited accounts',
    allowManualOpeningLine: true,
    drillDownTab: 'opening',
  },
  {
    glAccountCode: '3900',
    name: 'Retained earnings (opening plug)',
    primaryModule: 'computed',
    cutoverMethod: 'Auto balancing entry after all register rollups',
    allowManualOpeningLine: false,
    drillDownTab: 'opening',
  },
];

/** GL codes that must not appear on manual opening quick-add (register-first). */
export const OPENING_MANUAL_EXCLUDED_GL_CODES = GL_SOURCE_OF_TRUTH.filter(
  (m) => !m.allowManualOpeningLine
).map((m) => m.glAccountCode);

/**
 * @param {string} code
 * @returns {GlSourceMapping | undefined}
 */
export function glSourceMappingForCode(code) {
  const c = String(code || '').trim();
  if (c.startsWith('100') && c.length === 4) {
    return GL_SOURCE_OF_TRUTH.find((m) => m.glAccountCode === '1001');
  }
  if (c.startsWith('150') && c.length === 4) {
    return GL_SOURCE_OF_TRUTH.find((m) => m.glAccountCode === '1500');
  }
  return GL_SOURCE_OF_TRUTH.find((m) => m.glAccountCode === c);
}
