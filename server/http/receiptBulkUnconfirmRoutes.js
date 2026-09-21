import { requirePermission } from '../auth.js';
import { apiError } from '../apiError.js';
import { DEFAULT_BRANCH_ID } from '../branches.js';
import {
  bulkUnconfirmSalesReceiptsFinanceClearance,
  previewBulkUnconfirmSalesReceipts,
} from '../finance/receiptBulkUnconfirmOps.js';
import { RECEIPT_BULK_UNCONFIRM_CONFIRM_PHRASE } from '../../shared/lib/receiptClearance.js';

/**
 * Bulk unconfirm confirmed sales receipts for a branch + month/period (reconfirm workflow).
 * @param {import('express').Express} app
 * @param {object} db
 */
export function registerReceiptBulkUnconfirmRoutes(app, db) {
  const perm = requirePermission('finance.approve');

  app.get('/api/sales-receipts/bulk-unconfirm/preview', perm, (req, res) => {
    try {
      const branchScope = req.workspaceBranchId || DEFAULT_BRANCH_ID;
      const r = previewBulkUnconfirmSalesReceipts(db, branchScope, {
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
      const branchScope = req.workspaceBranchId || DEFAULT_BRANCH_ID;
      const body = req.body || {};
      const r = bulkUnconfirmSalesReceiptsFinanceClearance(db, branchScope, req.user, body);
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
