/**
 * Office / expense approval step list for memos and payment requests.
 * Thresholds live in `shared/workspaceGovernance.js`.
 * Frontend copies via `npm run sync:shared` → src/shared/lib/officeApprovalRouting.js
 */
import {
  EXPENSE_MD_APPROVAL_THRESHOLD_NGN,
  isBranchExpenseApproverRoleKey,
  isExecutiveRoleKey,
  isRefundLikeExpenseCategory,
} from '../workspaceGovernance.js';

export const EXPENSE_CATEGORIES = [
  'operational',
  'admin',
  'incident',
  'hr',
  'procurement',
  'maintenance',
  'fuel',
  'customer_refund',
  'production',
  'general_branch',
];

/**
 * @param {{ recordType?: string; expenseCategory?: string; amountNgn?: number; requesterRoleKey?: string; branchId?: string }} input
 * @returns {{ steps: { role: string; label: string }[]; requiresMd: boolean; nextActorRole: string }}
 */
export function computeOfficeApprovalRoute(input = {}) {
  const amount = Number(input.amountNgn) || 0;
  const cat = String(input.expenseCategory || input.recordType || 'general_branch')
    .trim()
    .toLowerCase();
  const requester = String(input.requesterRoleKey || 'sales_staff').toLowerCase();

  const steps = [{ role: 'sales_staff', label: 'Staff submission' }];
  steps.push({ role: 'sales_manager', label: 'Branch Manager endorsement' });

  const requiresMd =
    amount > EXPENSE_MD_APPROVAL_THRESHOLD_NGN && !isRefundLikeExpenseCategory(cat);

  if (/hr|leave|loan/.test(cat)) {
    steps.push({ role: 'hr_admin', label: 'HR / Admin review' });
    steps.push({ role: 'gmhr', label: 'GM HR approval' });
  } else if (/procurement|purchase/.test(cat)) {
    steps.push({ role: 'operations_officer', label: 'Procurement review' });
    if (requiresMd) steps.push({ role: 'md', label: 'MD approval (above ₦200,000)' });
    steps.push({ role: 'finance_manager', label: 'Finance oversight' });
  } else if (/fuel|diesel/.test(cat)) {
    steps.push({ role: 'cashier', label: 'Branch Cashier payment' });
    steps.push({ role: 'finance_manager', label: 'HQ Finance oversight' });
  } else if (/incident|operations/.test(cat)) {
    steps.push({ role: 'operations_officer', label: 'Operations / Admin' });
    if (requiresMd) steps.push({ role: 'md', label: 'MD approval' });
    steps.push({ role: 'finance_manager', label: 'Finance oversight' });
  } else if (/customer|refund/.test(cat)) {
    steps.push({ role: 'finance_manager', label: 'Finance review' });
    if (requiresMd) steps.push({ role: 'md', label: 'MD approval' });
  } else {
    if (requiresMd) steps.push({ role: 'md', label: 'MD approval (above ₦200,000)' });
    steps.push({ role: 'finance_manager', label: 'Finance / Cashier' });
  }

  const pending = steps.find((s) => s.role !== requester && !isExecutiveRoleKey(requester));
  const nextActorRole =
    requiresMd && !steps.some((s) => s.role === 'md')
      ? 'md'
      : pending?.role || 'sales_manager';

  return { steps, requiresMd, nextActorRole };
}

export function branchManagerCanApproveAmount(roleKey, amountNgn) {
  if (!isBranchExpenseApproverRoleKey(roleKey)) return false;
  return Number(amountNgn) <= EXPENSE_MD_APPROVAL_THRESHOLD_NGN;
}
