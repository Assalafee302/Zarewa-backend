/**
 * Canonical expense categories for Finance — server and client must stay aligned.
 * Use selects in UI; validate on API to avoid typos and inconsistent reporting.
 */
export const EXPENSE_CATEGORY_OPTIONS = Object.freeze([
  'COGS — raw materials & coil',
  'COGS — consumables & supplies',
  'Operational — rent & utilities',
  'Operational — professional & legal',
  'Employee — payroll & statutory',
  'Employee — staff welfare & training',
  'Logistics & haulage',
  'Maintenance — plant & equipment',
  'Marketing & business development',
  'Bank & finance charges',
  'Taxes & licences (non-payroll)',
  'Staff loan (disbursement)',
  'Other — misc operating',
]);

const SET = new Set(EXPENSE_CATEGORY_OPTIONS);

const FALLBACK = 'Other — misc operating';

/** Exact legacy labels (trimmed) → canonical option. */
const LEGACY_EXACT = new Map(
  Object.entries({
    'plant consumables': 'COGS — consumables & supplies',
    'materials': 'COGS — raw materials & coil',
    'utilities': 'Operational — rent & utilities',
    'phcn / diesel top-up': 'Operational — rent & utilities',
    rent: 'Operational — rent & utilities',
    'bank charges': 'Bank & finance charges',
    'legal fees': 'Operational — professional & legal',
    marketing: 'Marketing & business development',
    transport: 'Logistics & haulage',
    haulage: 'Logistics & haulage',
    maintenance: 'Maintenance — plant & equipment',
    payroll: 'Employee — payroll & statutory',
    'staff welfare': 'Employee — staff welfare & training',
    miscellaneous: FALLBACK,
    misc: FALLBACK,
    other: FALLBACK,
  })
);

export function isAllowedExpenseCategory(value) {
  const s = String(value ?? '').trim();
  return SET.has(s);
}

/**
 * Map former free-text expense categories to a canonical option (for one-time DB migration).
 * Already-canonical values are returned unchanged.
 */
export function mapLegacyExpenseCategoryToCanonical(value) {
  const s = String(value ?? '').trim();
  if (!s) return FALLBACK;
  if (SET.has(s)) return s;
  const lower = s.toLowerCase().replace(/\s+/g, ' ').trim();
  if (LEGACY_EXACT.has(lower)) return LEGACY_EXACT.get(lower);

  if (/(staff\s*loan|loan\s*disburs)/i.test(s)) return 'Staff loan (disbursement)';
  if (/(payroll|salary|paye|pension|statutory)/i.test(s)) return 'Employee — payroll & statutory';
  if (/(welfare|training)/i.test(s)) return 'Employee — staff welfare & training';
  if (/(rent|utility|utilities|phcn|diesel|power|generator)/i.test(s)) return 'Operational — rent & utilities';
  if (/(legal|professional|audit|consult)/i.test(s)) return 'Operational — professional & legal';
  if (/(marketing|advert|branding)/i.test(s)) return 'Marketing & business development';
  if (/(haulage|logistics|transport|freight)/i.test(s)) return 'Logistics & haulage';
  if (/(maintenance|repair|service\s*contract)/i.test(s)) return 'Maintenance — plant & equipment';
  if (/(bank|transfer\s*fee|interest\s*expense)/i.test(s)) return 'Bank & finance charges';
  if (/(tax|licen[cs]e|permit|fccpc)/i.test(s)) return 'Taxes & licences (non-payroll)';
  if (/(cogs|raw\s*material|coil|aluminium|aluzinc)/i.test(s)) return 'COGS — raw materials & coil';
  if (/(consumable|supply|supplies|stationery)/i.test(s)) return 'COGS — consumables & supplies';

  return FALLBACK;
}
