import { userHasPermission } from './auth.js';
import { DEFAULT_BRANCH_ID } from './branches.js';

export function normalizeWorkspaceBranchId(v) {
  return String(v ?? '').trim() || DEFAULT_BRANCH_ID;
}

/**
 * @param {object | null | undefined} user
 * @param {string | null | undefined} entityBranchId DB branch_id on the row (may be empty for legacy / shared rows)
 * @param {string | null | undefined} workspaceBranchId Session workspace branch
 */
export function entityBranchWriteAllowed(user, entityBranchId, workspaceBranchId) {
  if (userHasPermission(user, '*')) return true;
  const wb = normalizeWorkspaceBranchId(workspaceBranchId);
  const eb = String(entityBranchId ?? '').trim();
  if (!eb) {
    return wb === DEFAULT_BRANCH_ID;
  }
  return eb === wb;
}

/**
 * Shared catalogue products (e.g. coil SKUs) use empty branch_id — any workspace may post against them.
 */
export function productMutationAllowed(user, productBranchId, workspaceBranchId) {
  if (userHasPermission(user, '*')) return true;
  const pb = String(productBranchId ?? '').trim();
  if (!pb) return true;
  const wb = normalizeWorkspaceBranchId(workspaceBranchId);
  return pb === wb;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req
 * @param {string} cuttingListId
 */
export function assertCuttingListIdInWorkspace(db, req, cuttingListId) {
  const id = String(cuttingListId ?? '').trim();
  if (!id) return { ok: false, error: 'Cutting list id is required.', status: 400 };
  const row = db.prepare(`SELECT id, branch_id FROM cutting_lists WHERE id = ?`).get(id);
  if (!row) return { ok: false, error: 'Cutting list not found.', status: 404 };
  if (!entityBranchWriteAllowed(req.user, row.branch_id, req.workspaceBranchId)) {
    return { ok: false, error: 'This cutting list is not in your current workspace branch.', status: 403 };
  }
  return { ok: true };
}

/**
 * @param {import('express').Request} req
 * @param {{ branchId?: string; branch_id?: string } | null | undefined} cl from `getCuttingList`
 */
export function assertCuttingListRowInWorkspace(req, cl) {
  if (!cl) return { ok: false, error: 'Cutting list not found.', status: 404 };
  const bid = cl.branchId ?? cl.branch_id;
  if (!entityBranchWriteAllowed(req.user, bid, req.workspaceBranchId)) {
    return { ok: false, error: 'This cutting list is not in your current workspace branch.', status: 403 };
  }
  return { ok: true };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req
 * @param {string} jobId
 */
export function assertProductionJobIdInWorkspace(db, req, jobId) {
  const jid = String(jobId ?? '').trim();
  if (!jid) return { ok: false, error: 'Production job id is required.', status: 400 };
  const row = db.prepare(`SELECT job_id, branch_id FROM production_jobs WHERE job_id = ?`).get(jid);
  if (!row) return { ok: false, error: 'Production job not found.', status: 404 };
  if (!entityBranchWriteAllowed(req.user, row.branch_id, req.workspaceBranchId)) {
    return { ok: false, error: 'This production job is not in your current workspace branch.', status: 403 };
  }
  return { ok: true };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req
 * @param {string} productID
 */
export function assertProductIdInWorkspace(db, req, productID) {
  const pid = String(productID ?? '').trim();
  if (!pid) return { ok: false, error: 'Product is required.', status: 400 };
  const row = db.prepare(`SELECT product_id, branch_id FROM products WHERE product_id = ?`).get(pid);
  if (!row) return { ok: false, error: 'Product not found.', status: 404 };
  if (!productMutationAllowed(req.user, row.branch_id, req.workspaceBranchId)) {
    return { ok: false, error: 'This product is not in your current workspace branch.', status: 403 };
  }
  return { ok: true };
}
