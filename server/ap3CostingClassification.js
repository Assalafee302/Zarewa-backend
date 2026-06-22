/** Re-export shared AP3 costing classification — keep server import path stable. */
export {
  COSTING_EXPENSE_BUCKET_LABELS,
  PROPOSED_COSTING_POLICY,
  PROPOSED_COSTING_POLICY_NOTES,
  ap3CostingHintForCategory,
  classifyExpenseForCosting,
} from '../shared/lib/ap3CostingClassification.js';
