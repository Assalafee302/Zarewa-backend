import { requirePermission } from '../auth.js';
import { apiError } from '../apiError.js';
import {
  bulkUnconfirmSalesReceiptsFinanceClearance,
  previewBulkUnconfirmSalesReceipts,
} from '../finance/receiptBulkUnconfirmOps.js';
import { RECEIPT_BULK_UNCONFIRM_CONFIRM_PHRASE } from '../../shared/lib/receiptClearance.js';

/**
 * Bulk unconfirm is always single-branch. Never fall back to DEFAULT_BRANCH_ID or rollup ALL.
 * @param {import('express').Request} req
 * @returns {{ ok: true, branchScope: string } | { ok: false, code: string, error: string }}
 */
function resolveBulkUnconfirmBranchScope(req) {
  if (req.workspaceViewAll) {
    return {
      ok: false,
      code: 'BRANCH_REQUIRED',
      error: 'Open a specific branch workspace before bulk-unconfirming receipts (not All branches).',
    };
  }
  const branchScope = String(req.workspaceBranchId || '').trim();
  if (!branchScope || branchScope === 'ALL') {
    return {
      ok: false,
      code: 'BRANCH_REQUIRED',
      error: 'Open a specific branch workspace before bulk-unconfirming receipts.',
    };
  }
  return { ok: true, branchScope };
}

/**
 * Bulk unconfirm confirmed sales receipts for a branch + month/period (reconfirm workflow).
 * @param {import('express').Express} app
 * @param {object} db
 */
export function registerReceiptBulkUnconfirmRoutes(app, db) {
  const perm = requirePermission('finance.approve');

  app.get('/api/sales-receipts/bulk-unconfirm/preview', perm, (req, res) => {
    try {
      const scope = resolveBulkUnconfirmBranchScope(req);
      if (!scope.ok) return res.status(400).json(scope);
      const r = previewBulkUnconfirmSalesReceipts(db, scope.branchScope, {
        yearMonth: req.query?.yearMonth,
        dateFrom: req.query?.dateFrom,
        dateTo: req.query?.dateTo,
      });
      if (!r.ok) return res.status(400).json(r);
      return res.json({
        ...r,
        confirmPhraseRequired: RECEIPT_BULK_UNCONFIRM_CONFIRM_PHRASE,
      });
    } catch (e) {
      console.error(e);
      return apiError(res, {
        status: 500,
        code: 'BULK_UNCONFIRM_PREVIEW_FAILED',
        error: 'Could not preview bulk unconfirm.',
      });
    }
  });

  app.post('/api/sales-receipts/bulk-unconfirm', perm, (req, res) => {
    try {
      const scope = resolveBulkUnconfirmBranchScope(req);
      if (!scope.ok) return res.status(400).json(scope);
      const body = req.body || {};
      const r = bulkUnconfirmSalesReceiptsFinanceClearance(db, scope.branchScope, req.user, body);
      if (!r.ok && r.code === 'PARTIAL_FAILURE') {
        return res.status(207).json(r);
      }
      if (!r.ok) return res.status(400).json(r);
      return res.json(r);
    } catch (e) {
      console.error(e);
      return apiError(res, {
        status: 500,
        code: 'BULK_UNCONFIRM_FAILED',
        error: 'Could not bulk-unconfirm receipts.',
      });
    }
  });
}
