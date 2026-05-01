/**
 * Canonical expense categories for Finance & office memo → expense — server and client must stay aligned.
 * Use selects in UI; validate on API to avoid typos and inconsistent reporting.
 *
 * Spelling note: UK-style "licence" appears in governance elsewhere; category labels use common Nigerian business English.
 */
export const EXPENSE_CATEGORY_OPTIONS = Object.freeze([
  // Revenue / contra (where used on memos linked to P&L views)
  'Sales',
  'Refund',
  'Net sales',
  // Cost of sales & inventory
  'Purchases',
  'Accessories',
  'Carriage inward',
  'Production cost',
  'Closing stock',
  // Production & operations
  'Wages',
  'Fuel & lubricant',
  'Outside corrugation',
  'Maintenance',
  'Depreciation',
  // Admin & overheads
  'Admin expenses',
  'Admin salary',
  'Bank charges',
  'Rent & utilities',
  'Office expenses',
  'IT & software',
  'Insurance',
  'Professional fees',
  'Tax',
  'Pension',
  'Security',
  'Interest',
  'Welfare',
  'Zakat & Sallah',
  'Marketing & advertising',
  // Corporate / other
  'HQ',
  'Chairman withdrawal',
  'Truck & mining',
  'Staff loan',
  'Others',
  'Miscellaneous',
  // Fixed assets (capex / allocations — classify per policy)
  'Land and buildings',
  'Plant and machinery',
  'Furniture & fittings',
  'Generator',
]);

const SET = new Set(EXPENSE_CATEGORY_OPTIONS);

const FALLBACK = 'Others';

/** Prior canonical labels (v1) → current option (migration / imports). */
const PREVIOUS_CANONICAL = new Map([
  ['COGS — raw materials & coil', 'Purchases'],
  ['COGS — consumables & supplies', 'Accessories'],
  ['Operational — rent & utilities', 'Rent & utilities'],
  ['Operational — professional & legal', 'Professional fees'],
  ['Employee — payroll & statutory', 'Admin salary'],
  ['Employee — staff welfare & training', 'Welfare'],
  ['Logistics & haulage', 'Truck & mining'],
  ['Maintenance — plant & equipment', 'Maintenance'],
  ['Marketing & business development', 'Marketing & advertising'],
  ['Bank & finance charges', 'Bank charges'],
  ['Taxes & licences (non-payroll)', 'Tax'],
  ['Staff loan (disbursement)', 'Staff loan'],
  ['Other — misc operating', 'Others'],
]);

/** Exact legacy labels (trimmed, lowercased) → canonical option. */
const LEGACY_EXACT = new Map(
  Object.entries({
    'plant consumables': 'Accessories',
    materials: 'Purchases',
    utilities: 'Rent & utilities',
    'phcn / diesel top-up': 'Rent & utilities',
    rent: 'Rent & utilities',
    'bank charges': 'Bank charges',
    'legal fees': 'Professional fees',
    marketing: 'Marketing & advertising',
    transport: 'Truck & mining',
    haulage: 'Truck & mining',
    maintenance: 'Maintenance',
    payroll: 'Admin salary',
    'staff welfare': 'Welfare',
    miscellaneous: 'Miscellaneous',
    misc: 'Miscellaneous',
    other: 'Others',
    'maintainace': 'Maintenance',
    'currugation': 'Outside corrugation',
    'corrugation': 'Outside corrugation',
    intrest: 'Interest',
    micelanious: 'Miscellaneous',
    'land and building': 'Land and buildings',
    machineries: 'Plant and machinery',
    'furnitures & fittings': 'Furniture & fittings',
    'furnitures': 'Furniture & fittings',
    'mining': 'Truck & mining',
  })
);

export function isAllowedExpenseCategory(value) {
  const s = String(value ?? '').trim();
  return SET.has(s);
}

/**
 * Map former free-text or prior-canonical expense categories to a current option.
 * Already-canonical values are returned unchanged.
 */
export function mapLegacyExpenseCategoryToCanonical(value) {
  const s = String(value ?? '').trim();
  if (!s) return FALLBACK;
  if (SET.has(s)) return s;
  if (PREVIOUS_CANONICAL.has(s)) return PREVIOUS_CANONICAL.get(s);

  const lower = s.toLowerCase().replace(/\s+/g, ' ').trim();
  if (LEGACY_EXACT.has(lower)) return LEGACY_EXACT.get(lower);

  if (/(staff\s*loan|loan\s*disburs)/i.test(s)) return 'Staff loan';
  if (/(payroll|salary|paye|statutory|nhis)/i.test(s)) return 'Admin salary';
  if (/(welfare|training)/i.test(s)) return 'Welfare';
  if (/(rent|utility|utilities|phcn|diesel|power)\b/i.test(s) && !/generator/i.test(s)) return 'Rent & utilities';
  if (/\bgenerator\b/i.test(s)) return 'Generator';
  if (/(legal|professional|audit|consult)/i.test(s)) return 'Professional fees';
  if (/(marketing|advert|branding)/i.test(s)) return 'Marketing & advertising';
  if (/(haulage|logistics|freight|carriage)/i.test(s)) return 'Truck & mining';
  if (/(vehicle|truck|fleet|transport)/i.test(s)) return 'Truck & mining';
  if (/(maintenance|repair|service\s*contract)/i.test(s)) return 'Maintenance';
  if (/(^interest|interest\s*expense|\binterest\b)/i.test(s)) return 'Interest';
  if (/(bank|transfer\s*fee)/i.test(s)) return 'Bank charges';
  if (/(tax|licen[cs]e|permit|fccpc)/i.test(s)) return 'Tax';
  if (/(pension|pencom)/i.test(s)) return 'Pension';
  if (/(insurance|premium)/i.test(s)) return 'Insurance';
  if (/(software|saas|subscription|internet|data|it\b|computer)/i.test(s)) return 'IT & software';
  if (/(cogs|raw\s*material|coil|aluminium|aluzinc)/i.test(s)) return 'Purchases';
  if (/(consumable|supply|supplies|stationery)/i.test(s)) return 'Accessories';
  if (/(security|guard)/i.test(s)) return 'Security';
  if (/(zakat|sallah|sadaqah)/i.test(s)) return 'Zakat & Sallah';
  if (/(depreciat)/i.test(s)) return 'Depreciation';
  if (/(chairman|director).*(draw|withdraw)/i.test(s)) return 'Chairman withdrawal';
  if (/\bhq\b|head\s*office/i.test(s)) return 'HQ';

  return FALLBACK;
}
