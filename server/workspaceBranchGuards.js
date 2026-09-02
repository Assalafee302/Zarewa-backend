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
        ? 'Global coil catalog product is not stocked in this branch. Receive coil via GRN into branch inventory before transfers or production.'
        : 'Product not found for this branch. Open the correct branch workspace or receive stock here first.',
      status: 404,
    };
  }
  if (!productMutationAllowed(req.user, row.branch_id, req.workspaceBranchId)) {
    return { ok: false, error: 'This product is not in your current workspace branch.', status: 403 };
  }
  return { ok: true };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req
 * @param {string} deliveryId
 */
export function assertDeliveryIdInWorkspace(db, req, deliveryId) {
  const id = String(deliveryId ?? '').trim();
  if (!id) return { ok: false, error: 'Delivery id is required.', status: 400 };
  const row = db.prepare(`SELECT id, branch_id FROM deliveries WHERE id = ?`).get(id);
  if (!row) return { ok: false, error: 'Delivery not found.', status: 404 };
  const gate = assertEntityBranchForWorkspaceWrite(
    req.user,
    row.branch_id,
    req.workspaceBranchId,
    Boolean(req.workspaceViewAll)
  );
  if (!gate.ok) return { ok: false, error: gate.error, status: 403 };
  return { ok: true };
}

function resolveSalesReceiptBranchId(db, receiptRow) {
  const ledgerId = String(receiptRow?.ledger_entry_id ?? '').trim();
  if (ledgerId) {
    const le = db.prepare(`SELECT branch_id FROM ledger_entries WHERE id = ?`).get(ledgerId);
    const bid = String(le?.branch_id ?? '').trim();
    if (bid) return bid;
  }
  const qref = String(receiptRow?.quotation_ref ?? '').trim();
  if (qref) {
    const q = db.prepare(`SELECT branch_id FROM quotations WHERE id = ?`).get(qref);
    const bid = String(q?.branch_id ?? '').trim();
    if (bid) return bid;
  }
  const cid = String(receiptRow?.customer_id ?? '').trim();
  if (cid) {
    const c = db.prepare(`SELECT branch_id FROM customers WHERE customer_id = ?`).get(cid);
    const bid = String(c?.branch_id ?? '').trim();
    if (bid) return bid;
  }
  return '';
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req
 * @param {string} receiptToken sales_receipts.id or ledger_entries.id
 */
export function assertSalesReceiptIdInWorkspace(db, req, receiptToken) {
  const token = String(receiptToken ?? '').trim();
  if (!token) return { ok: false, error: 'Receipt id is required.', status: 400 };
  const row = db
    .prepare(
      `SELECT id, ledger_entry_id, quotation_ref, customer_id FROM sales_receipts
       WHERE id = ? OR (ledger_entry_id IS NOT NULL AND ledger_entry_id = ?)`
    )
    .get(token, token);
  if (!row) return { ok: false, error: 'Receipt not found.', status: 404 };
  const gate = assertEntityBranchForWorkspaceWrite(
    req.user,
    resolveSalesReceiptBranchId(db, row),
    req.workspaceBranchId,
    Boolean(req.workspaceViewAll)
  );
  if (!gate.ok) return { ok: false, error: gate.error, status: 403 };
  return { ok: true };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req
 * @param {string} machineId
 */
export function assertMachineIdInWorkspace(db, req, machineId) {
  const id = String(machineId ?? '').trim();
  if (!id) return { ok: false, error: 'Machine id is required.', status: 400 };
  const row = db.prepare(`SELECT id, branch_id FROM machines WHERE id = ?`).get(id);
  if (!row) return { ok: false, error: 'Machine not found.', status: 404 };
  const gate = assertEntityBranchForWorkspaceWrite(
    req.user,
    row.branch_id,
    req.workspaceBranchId,
    Boolean(req.workspaceViewAll)
  );
  if (!gate.ok) return { ok: false, error: gate.error, status: 403 };
  return { ok: true, row };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req
 * @param {string} planId
 */
export function assertMaintenancePlanIdInWorkspace(db, req, planId) {
  const id = String(planId ?? '').trim();
  if (!id) return { ok: false, error: 'Service plan id is required.', status: 400 };
  const row = db.prepare(`SELECT id, branch_id FROM maintenance_plans WHERE id = ?`).get(id);
  if (!row) return { ok: false, error: 'Service plan not found.', status: 404 };
  const gate = assertEntityBranchForWorkspaceWrite(
    req.user,
    row.branch_id,
    req.workspaceBranchId,
    Boolean(req.workspaceViewAll)
  );
  if (!gate.ok) return { ok: false, error: gate.error, status: 403 };
  return { ok: true, row };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req
 * @param {string} workOrderId
 */
export function assertMaintenanceWorkOrderIdInWorkspace(db, req, workOrderId) {
  const id = String(workOrderId ?? '').trim();
  if (!id) return { ok: false, error: 'Work order id is required.', status: 400 };
  const row = db.prepare(`SELECT id, branch_id FROM maintenance_work_orders WHERE id = ?`).get(id);
  if (!row) return { ok: false, error: 'Work order not found.', status: 404 };
  const gate = assertEntityBranchForWorkspaceWrite(
    req.user,
    row.branch_id,
    req.workspaceBranchId,
    Boolean(req.workspaceViewAll)
  );
  if (!gate.ok) return { ok: false, error: gate.error, status: 403 };
  return { ok: true, row };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {import('express').Request} req
 * @param {string} requestId
 */
export function assertPaymentRequestIdInWorkspace(db, req, requestId) {
  const rid = String(requestId ?? '').trim();
  if (!rid) return { ok: false, error: 'Payment request id is required.', status: 400 };
  const row = db
    .prepare(
      `SELECT pr.request_id, e.branch_id AS expense_branch_id
       FROM payment_requests pr
       LEFT JOIN expenses e ON e.expense_id = pr.expense_id
       WHERE pr.request_id = ?`
    )
    .get(rid);
  if (!row) return { ok: false, error: 'Payment request not found.', status: 404 };
  const gate = assertEntityBranchForWorkspaceWrite(
    req.user,
    row.expense_branch_id,
    req.workspaceBranchId,
    Boolean(req.workspaceViewAll)
  );
  if (!gate.ok) return { ok: false, error: gate.error, status: 403 };
  return { ok: true };
}
