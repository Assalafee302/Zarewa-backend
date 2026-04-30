import { canUseAllBranchesRollup, userHasPermission } from './auth.js';
import { DEFAULT_BRANCH_ID } from './branches.js';

/** Users with this permission may post ledger cash movements for customers outside the active workspace branch. */
export const FINANCE_CROSS_BRANCH_POST = 'finance.cross_branch_post';

/**
 * @param {{ workspaceBranchId?: string; workspaceViewAll?: boolean; user?: object | null }} req
 * @returns {'ALL' | string}
 */
export function resolveBootstrapBranchScope(req) {
  if (req.workspaceViewAll && canUseAllBranchesRollup(req.user)) {
    return 'ALL';
  }
  return String(req.workspaceBranchId || '').trim() || DEFAULT_BRANCH_ID;
}

/**
 * Prevent booking receipts/advances to the wrong branch when read scope is ALL (HQ rollup).
 * @param {{ branchId?: string; branch_id?: string } | null | undefined} customer from `getCustomer` / raw row
 * @param {{ workspaceBranchId?: string; user?: object | null }} req
 * @returns {{ ok: true } | { ok: false; error: string }}
 */
export function assertCustomerLedgerPostingBranch(customer, req) {
  if (!customer || !req?.user) return { ok: true };
  const wb = String(req.workspaceBranchId || '').trim() || DEFAULT_BRANCH_ID;
  const cb = String(customer.branchId ?? customer.branch_id ?? '').trim();
  if (!cb || cb === wb) return { ok: true };
  if (userHasPermission(req.user, FINANCE_CROSS_BRANCH_POST) || userHasPermission(req.user, '*')) {
    return { ok: true };
  }
  return {
    ok: false,
    error: `This customer belongs to branch ${cb}. Switch workspace to that branch before posting, or use a finance role with cross-branch posting.`,
  };
}
