/**
 * Negative ACC/STONE stock: OM or branch manager approves with reason ≥ 10 chars.
 * Approver must not be the person completing the job.
 */
import { normalizeRoleKey } from '../auth.js';
import { correctionReasonBlock } from './coilCorrectionControl.js';
export { isNegativeStockGateActive } from '../productBranchInventory.js';

const APPROVER_ROLES = new Set([
  'branch_manager',
  'operations_manager',
  'ops_manager',
  'admin',
]);

export function userMayApproveNegativeStock(user) {
  const rk = normalizeRoleKey(user?.roleKey ?? user?.role_key);
  return APPROVER_ROLES.has(rk);
}

/**
 * Create a reusable approval for a forthcoming overdraw.
 */
export function createNegativeStockApproval(db, payload, actor) {
  if (!userMayApproveNegativeStock(actor)) {
    return { ok: false, error: 'Only an Operations Manager or Branch Manager may approve negative stock.' };
  }
  const reasonBlock = correctionReasonBlock(payload?.reason);
  if (reasonBlock) return { ok: false, error: reasonBlock };

  const branchId = String(payload?.branchId || payload?.branch_id || '').trim();
  const productId = String(payload?.productId || payload?.product_id || '').trim();
  const qtyRequested = Math.abs(Number(payload?.qtyRequested ?? payload?.qty) || 0);
  if (!branchId || !productId) {
    return { ok: false, error: 'branchId and productId are required.' };
  }
  if (!(qtyRequested > 0)) {
    return { ok: false, error: 'qtyRequested must be positive.' };
  }

  const id =
    String(payload?.id || '').trim() ||
    `NSA-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const at = new Date().toISOString();
  db.prepare(
    `INSERT INTO negative_stock_approvals (
       id, branch_id, product_id, job_id, ref, qty_requested, stock_before, reason,
       approved_by_user_id, approved_by_name, approved_at_iso, status
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?, 'approved')`
  ).run(
    id,
    branchId,
    productId,
    String(payload?.jobId || payload?.job_id || '').trim() || null,
    String(payload?.ref || '').trim() || null,
    qtyRequested,
    payload?.stockBefore != null ? Number(payload.stockBefore) : null,
    String(payload.reason).trim(),
    String(actor.id),
    actor.name || actor.displayName || null,
    at
  );
  return { ok: true, id, approvedAtIso: at };
}

/**
 * Consume an approval inside the same transaction as the stock draw.
 * Approver must differ from the completer.
 * @returns {{ ok: true } | { ok: false, error: string, code?: string }}
 */
export function consumeNegativeStockApprovalTx(db, { approvalId, productId, branchId, actor, qty }) {
  const aid = String(approvalId || '').trim();
  if (!aid) {
    return {
      ok: false,
      code: 'NEGATIVE_STOCK_APPROVAL_REQUIRED',
      error: 'This issue would take stock below zero. An OM or Branch Manager must approve with a reason first.',
    };
  }
  const row = db.prepare(`SELECT * FROM negative_stock_approvals WHERE id = ?`).get(aid);
  if (!row || String(row.status) !== 'approved') {
    return { ok: false, error: 'Negative-stock approval is missing or already used.' };
  }
  if (String(row.product_id) !== String(productId || '').trim()) {
    return { ok: false, error: 'Negative-stock approval is for a different product.' };
  }
  if (String(row.branch_id) !== String(branchId || '').trim()) {
    return { ok: false, error: 'Negative-stock approval is for a different branch.' };
  }
  const approverId = String(row.approved_by_user_id || '').trim();
  const actorId = String(actor?.id || '').trim();
  if (approverId && actorId && approverId === actorId) {
    return {
      ok: false,
      error: 'The person completing the job cannot be the negative-stock approver.',
    };
  }
  const need = Math.abs(Number(qty) || 0);
  if (need > Number(row.qty_requested) + 1e-6) {
    return {
      ok: false,
      error: `Approval covers ${row.qty_requested} units but ${need} would be drawn below zero.`,
    };
  }
  db.prepare(
    `UPDATE negative_stock_approvals
     SET status = 'consumed', consumed_at_iso = ?, consumed_by_user_id = ?
     WHERE id = ?`
  ).run(new Date().toISOString(), actorId || null, aid);
  return { ok: true };
}

export function listNegativeStockApprovalsForOm(db, { branchId = '', limit = 50 } = {}) {
  const lim = Math.min(200, Math.max(1, Number(limit) || 50));
  const bid = String(branchId || '').trim();
  if (bid && bid !== 'ALL') {
    return db
      .prepare(
        `SELECT * FROM negative_stock_approvals
         WHERE branch_id = ?
         ORDER BY approved_at_iso DESC LIMIT ?`
      )
      .all(bid, lim);
  }
  return db
    .prepare(`SELECT * FROM negative_stock_approvals ORDER BY approved_at_iso DESC LIMIT ?`)
    .all(lim);
}

export { isNegativeStockGateActive };
