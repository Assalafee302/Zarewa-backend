import { canUseAllBranchesRollup, userHasPermission } from './auth.js';
import { DEFAULT_BRANCH_ID, getBranch } from './branches.js';

/** Users with this permission may post ledger cash movements for customers outside the active workspace branch. */
export const FINANCE_CROSS_BRANCH_POST = 'finance.cross_branch_post';

/** HQ “all branches” view is read-only rollup unless this permission is granted. */
export function userMayPostAcrossBranches(user) {
  if (!user) return false;
  return userHasPermission(user, FINANCE_CROSS_BRANCH_POST) || userHasPermission(user, '*');
}

/**
 * Block writes against another branch’s row. View-all alone does not allow cross-branch mutation.
 * @param {object | null | undefined} user
 * @param {string | null | undefined} entityBranchId
 * @param {string | null | undefined} workspaceBranchId
 * @param {boolean} [workspaceViewAll]
 */
export function assertEntityBranchForWorkspaceWrite(user, entityBranchId, workspaceBranchId, workspaceViewAll = false) {
  const eb = String(entityBranchId ?? '').trim();
  const wb = String(workspaceBranchId ?? '').trim() || DEFAULT_BRANCH_ID;
  if (!eb || eb === wb) return { ok: true };
  if (userMayPostAcrossBranches(user)) return { ok: true };
  if (workspaceViewAll) {
    return {
      ok: false,
      error: `This record belongs to branch ${eb}. Turn off “all branches” and open that branch’s workspace, or use a finance role with cross-branch posting.`,
    };
  }
  return {
    ok: false,
    error: `This record belongs to branch ${eb}. Switch your workspace to that branch before continuing.`,
  };
}

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
/**
 * Treasury payouts must use an account registered for the active workspace branch (unless cross-branch finance).
 * @param {import('better-sqlite3').Database} db
 * @param {number} treasuryAccountId
 * @param {{ workspaceBranchId?: string; workspaceViewAll?: boolean; user?: object | null }} req
 */
export function assertTreasuryAccountForWorkspace(db, treasuryAccountId, req) {
  if (!req?.user) return { ok: true };
  const wb = String(req.workspaceBranchId || '').trim();
  if (!wb || wb === 'ALL') return { ok: true };
  const tid = Number(treasuryAccountId);
  if (!tid) return { ok: false, error: 'Treasury account is required.' };
  const row = db.prepare(`SELECT branch_id FROM treasury_accounts WHERE id = ?`).get(tid);
  if (!row) return { ok: false, error: 'Treasury account not found.' };
  const ab = String(row.branch_id || '').trim() || DEFAULT_BRANCH_ID;
  if (ab === wb) return { ok: true };
  if (userMayPostAcrossBranches(req.user)) return { ok: true };
  const branch = getBranch(db, ab);
  return {
    ok: false,
    error: `This treasury account belongs to ${branch?.name || ab}. Switch your workspace to that branch, or use a finance role with cross-branch posting.`,
  };
}

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
