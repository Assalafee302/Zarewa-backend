/**
 * AP3a — expense buckets for costing readiness (read-only classification; no category edits).
 */
import {
  mapLegacyExpenseCategoryToCanonical,
  isAllowedExpenseCategory,
} from '../expenseCategories.js';

/** @typedef {'production_labour'|'diesel_fuel'|'production_repairs_maintenance'|'factory_consumables'|'transport_landing'|'admin_office'|'selling_marketing'|'finance_bank'|'owner_drawings'|'unclassified'} CostingExpenseBucket */

export const COSTING_EXPENSE_BUCKET_LABELS = Object.freeze({
  production_labour: 'Production labour',
  diesel_fuel: 'Diesel / fuel',
  production_repairs_maintenance: 'Production repairs / maintenance',
  factory_consumables: 'Factory consumables',
  transport_landing: 'Transport / landing cost',
  admin_office: 'Admin / office expenses',
  selling_marketing: 'Selling / marketing',
  finance_bank: 'Finance / bank charges',
  owner_drawings: 'Owner drawings',
  unclassified: 'Unclassified',
});

/** Canonical expense category → costing readiness bucket. */
const CANONICAL_TO_BUCKET = Object.freeze({
  Wages: 'production_labour',
  'Production cost': 'production_labour',
  'Outside corrugation': 'production_labour',
  'Fuel & lubricant': 'diesel_fuel',
  Maintenance: 'production_repairs_maintenance',
  Depreciation: 'production_repairs_maintenance',
  Accessories: 'factory_consumables',
  'Carriage inward': 'transport_landing',
  Purchases: 'factory_consumables',
  'Closing stock': 'unclassified',
  'Admin expenses': 'admin_office',
  'Admin salary': 'production_labour',
  'Rent & utilities': 'admin_office',
  'Office expenses': 'admin_office',
  'IT & software': 'admin_office',
  Insurance: 'admin_office',
  'Professional fees': 'admin_office',
  Tax: 'admin_office',
  Pension: 'production_labour',
  Security: 'admin_office',
  Interest: 'finance_bank',
  Welfare: 'production_labour',
  'Zakat & Sallah': 'admin_office',
  'Marketing & advertising': 'selling_marketing',
  HQ: 'admin_office',
  'Chairman withdrawal': 'owner_drawings',
  'Truck & mining': 'transport_landing',
  'Staff loan': 'finance_bank',
  Others: 'unclassified',
  Miscellaneous: 'unclassified',
  'Land and buildings': 'unclassified',
  'Plant and machinery': 'unclassified',
  'Furniture & fittings': 'admin_office',
  Generator: 'diesel_fuel',
  Sales: 'unclassified',
  Refund: 'unclassified',
  'Net sales': 'unclassified',
  'Bank charges': 'finance_bank',
});

/**
 * @param {string} rawCategory
 * @returns {{ bucket: CostingExpenseBucket; canonical: string; mapped: boolean }}
 */
export function classifyExpenseForCosting(rawCategory) {
  const canonical = mapLegacyExpenseCategoryToCanonical(rawCategory);
  const bucket = CANONICAL_TO_BUCKET[canonical] || 'unclassified';
  const mapped = Boolean(CANONICAL_TO_BUCKET[canonical]);
  const allowed = isAllowedExpenseCategory(canonical);
  return {
    bucket,
    canonical,
    mapped: mapped && allowed,
  };
}

/**
 * UI hint for AP3 costing lane on category pickers.
 * @param {string} category
 */
export function ap3CostingHintForCategory(category) {
  const { bucket, canonical, mapped } = classifyExpenseForCosting(category);
  const label = COSTING_EXPENSE_BUCKET_LABELS[bucket] || bucket;
  return {
    bucket,
    label,
    canonical,
    mapped,
    isUnclassified: bucket === 'unclassified',
    affectsCostPerMetre: bucket !== 'unclassified' && bucket !== 'owner_drawings',
  };
}

export const PROPOSED_COSTING_POLICY = Object.freeze({
  materialCostBasis: 'actual_coil_consumption',
  materialFallback: 'landed_cost_then_unit_cost_then_missing',
  labourAllocation: 'branch_monthly_production_metres',
  dieselAllocation: 'branch_monthly_production_metres',
  productionOverheadAllocation: 'branch_monthly_production_metres',
  hqSharedCostsInCostPerMetre: false,
  adminExpensesInCostPerMetre: false,
  sellingExpensesInCostPerMetre: false,
  ownerDrawingsInCostPerMetre: false,
  costingLevelStart: ['branch', 'product_family'],
  costingLevelLater: ['gauge_colour', 'quotation_job'],
  visibility: ['md', 'head_of_accounts', 'finance_manager'],
  sellingBelowCostMode: 'warn_only_later',
});

export const PROPOSED_COSTING_POLICY_NOTES = Object.freeze([
  'This policy is a proposal and requires MD / Head of Accounts approval.',
  'AP3a does not post GL or change costing.',
  'Full cost per metre should not be trusted until missing data is reviewed.',
]);
