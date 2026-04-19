/**
 * Monthly MD / leadership operations snapshot (exceptions-oriented).
 */
import { DEFAULT_BRANCH_ID } from './branches.js';
import { getOrgGovernanceLimits } from './orgPolicy.js';
import { interBranchOfficeTableReady } from './interBranchOfficeOps.js';

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ monthKey: string; branchId?: string; viewAll?: boolean }} opts monthKey = YYYY-MM
 */
export function buildMdOperationsPack(db, opts) {
  const monthKey = String(opts?.monthKey || '').trim().slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(monthKey)) {
    return { ok: false, error: 'monthKey must be YYYY-MM.' };
  }
  const limits = getOrgGovernanceLimits(db);
  const branchClause =
    opts?.viewAll || !opts?.branchId
      ? { sql: '', args: [] }
      : { sql: ` AND (e.branch_id = ? OR e.branch_id IS NULL)`, args: [String(opts.branchId || DEFAULT_BRANCH_ID).trim()] };

  const expenseHi = limits.expenseExecutiveThresholdNgn;
  const refundHi = limits.refundExecutiveThresholdNgn;

  const largePaymentCount = db
    .prepare(
      `SELECT COUNT(*) AS c FROM payment_requests pr
       LEFT JOIN expenses e ON e.expense_id = pr.expense_id
       WHERE strftime('%Y-%m', COALESCE(pr.approved_at_iso, pr.request_date)) = ?
         AND TRIM(LOWER(COALESCE(pr.approval_status,''))) = 'approved'
         AND COALESCE(pr.amount_requested_ngn, 0) > ?
         ${branchClause.sql}`
    )
    .get(monthKey, expenseHi, ...branchClause.args).c;

  const pendingRefundCount = db
    .prepare(`SELECT COUNT(*) AS c FROM customer_refunds WHERE TRIM(LOWER(COALESCE(status,''))) = 'pending'`)
    .get().c;

  let unfiledSql = `
    SELECT COUNT(*) AS c FROM work_items wi
    LEFT JOIN work_item_filing wf ON wf.work_item_id = wi.id
    WHERE wi.document_type IN ('payment_request','refund_request','bank_recon_exceptions','po_transport_payment')
      AND (wi.archived_at_iso IS NULL OR TRIM(wi.archived_at_iso) = '')
      AND (wi.status IN ('closed','approved','completed','paid') OR (wi.requires_approval = 0 AND wi.requires_response = 0))
      AND (wf.filing_reference IS NULL OR TRIM(wf.filing_reference) = '')
  `;
  const unfiledArgs = [];
  if (!opts?.viewAll && opts?.branchId) {
    unfiledSql += ` AND wi.branch_id = ?`;
    unfiledArgs.push(String(opts.branchId).trim());
  }
  const unfiledIncompleteCount = db.prepare(unfiledSql).get(...unfiledArgs).c;

  const interBranchOpen = interBranchOfficeTableReady(db)
    ? db
        .prepare(
          `SELECT COUNT(*) AS c FROM office_inter_branch_requests WHERE TRIM(LOWER(COALESCE(status,''))) = 'open'`
        )
        .get().c
    : 0;

  return {
    ok: true,
    monthKey,
    generatedAtIso: new Date().toISOString(),
    limits: {
      expenseExecutiveThresholdNgn: expenseHi,
      refundExecutiveThresholdNgn: refundHi,
    },
    counts: {
      approvedPaymentRequestsAboveExpenseThreshold: Number(largePaymentCount) || 0,
      refundsPendingInMonth: Number(pendingRefundCount) || 0,
      unfiledWorkItemsIncomplete: Number(unfiledIncompleteCount) || 0,
      interBranchRequestsOpen: Number(interBranchOpen) || 0,
    },
    notes: [
      'Branch manager sign-off for the period can be recorded when period-close workflow is enabled.',
      'Drill into Accounts → Payment requests and Manager → Refunds for line detail.',
    ],
  };
}
