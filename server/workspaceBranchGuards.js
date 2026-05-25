import { userHasPermission } from './auth.js';
import { assertEntityBranchForWorkspaceWrite } from './branchScope.js';
import { DEFAULT_BRANCH_ID } from './branches.js';
import { getProductRowForWorkspace, isGlobalCoilCatalogProductId } from './productBranchInventory.js';

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
/**
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req
 * @param {string} poId
 */
export function assertPurchaseOrderIdInWorkspace(db, req, poId) {
  const id = String(poId ?? '').trim();
  if (!id) return { ok: false, error: 'Purchase order id is required.', status: 400 };
  const row = db.prepare(`SELECT po_id, branch_id FROM purchase_orders WHERE po_id = ?`).get(id);
  if (!row) return { ok: false, error: 'Purchase order not found.', status: 404 };
  const gate = assertEntityBranchForWorkspaceWrite(
    req.user,
    row.branch_id,
    req.workspaceBranchId,
    Boolean(req.workspaceViewAll)
  );
  if (!gate.ok) return { ok: false, error: gate.error, status: 403 };
  return { ok: true };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req
 * @param {string} quotationId
 */
export function assertQuotationIdInWorkspace(db, req, quotationId) {
  const id = String(quotationId ?? '').trim();
  if (!id) return { ok: false, error: 'Quotation id is required.', status: 400 };
  const row = db.prepare(`SELECT id, branch_id FROM quotations WHERE id = ?`).get(id);
  if (!row) return { ok: false, error: 'Quotation not found.', status: 404 };
  const gate = assertEntityBranchForWorkspaceWrite(
    req.user,
    row.branch_id,
    req.workspaceBranchId,
    Boolean(req.workspaceViewAll)
  );
  if (!gate.ok) return { ok: false, error: gate.error, status: 403 };
  return { ok: true };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req
 * @param {string} refundId
 */
export function assertRefundIdInWorkspace(db, req, refundId) {
  const id = String(refundId ?? '').trim();
  if (!id) return { ok: false, error: 'Refund id is required.', status: 400 };
  const row = db.prepare(`SELECT refund_id, branch_id FROM customer_refunds WHERE refund_id = ?`).get(id);
  if (!row) return { ok: false, error: 'Refund not found.', status: 404 };
  const gate = assertEntityBranchForWorkspaceWrite(
    req.user,
    row.branch_id,
    req.workspaceBranchId,
    Boolean(req.workspaceViewAll)
  );
  if (!gate.ok) return { ok: false, error: gate.error, status: 403 };
  return { ok: true };
}

export function assertProductIdInWorkspace(db, req, productID) {
  const pid = String(productID ?? '').trim();
  if (!pid) return { ok: false, error: 'Product is required.', status: 400 };
  const row = getProductRowForWorkspace(db, pid, req.workspaceBranchId);
  if (!row) {
    return {
      ok: false,
      error: isGlobalCoilCatalogProductId(pid)
        ? 'Product not found.'
        : 'Product not found for this branch. Open the correct branch workspace or receive stock here first.',
      status: 404,
    };
  }
  if (!productMutationAllowed(req.user, row.branch_id, req.workspaceBranchId)) {
    return { ok: false, error: 'This product is not in your current workspace branch.', status: 403 };
  }
  return { ok: true };
}
