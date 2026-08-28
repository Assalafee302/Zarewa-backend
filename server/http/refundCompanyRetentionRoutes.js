/**
 * Company retention from refund staff cuts — balance, BM approve withdraw, cashier pay.
 */
import { requirePermission } from '../auth.js';
import { resolveBootstrapBranchScope } from '../branchScope.js';
import { DEFAULT_BRANCH_ID } from '../branches.js';
import { backfillMissingRefundCompanyRetentionCredits } from '../finance/partnerWalletCredit.js';
import {
  decideCompanyRetentionWithdrawal,
  getCompanyRetentionSummary,
  payCompanyRetentionWithdrawal,
  requestCompanyRetentionWithdrawal,
} from '../finance/refundCompanyRetentionOps.js';

/**
 * @param {import('express').Express} app
 * @param {object} db
 */
export function registerRefundCompanyRetentionRoutes(app, db) {
  app.get(
    '/api/refund-company-retention',
    requirePermission(['finance.view', 'finance.pay', 'refunds.approve', 'cashier.desk.view']),
    (req, res) => {
      try {
        const branchScope = resolveBootstrapBranchScope(req);
        backfillMissingRefundCompanyRetentionCredits(db, branchScope, {
          actor: req.user,
        });
        const summary = getCompanyRetentionSummary(db, branchScope);
        res.json(summary);
      } catch (e) {
        console.error('[refund-company-retention]', e);
        res.status(500).json({ ok: false, error: 'Failed to load company retention balance.' });
      }
    }
  );

  app.post(
    '/api/refund-company-retention/withdrawals',
    requirePermission(['finance.pay', 'refunds.approve', 'finance.approve']),
    (req, res) => {
      try {
        const branchId =
          String(req.body?.branchId || req.workspaceBranchId || DEFAULT_BRANCH_ID).trim() ||
          DEFAULT_BRANCH_ID;
        const r = requestCompanyRetentionWithdrawal(db, {
          ...(req.body || {}),
          branchId,
          actor: req.user,
        });
        res.status(r.ok ? 201 : 400).json(r);
      } catch (e) {
        console.error('[refund-company-retention/withdrawals]', e);
        res.status(400).json({ ok: false, error: String(e.message || e) });
      }
    }
  );

  app.post(
    '/api/refund-company-retention/withdrawals/:id/decide',
    requirePermission(['refunds.approve', 'finance.approve']),
    (req, res) => {
      try {
        const r = decideCompanyRetentionWithdrawal(db, {
          ...(req.body || {}),
          withdrawalId: req.params.id,
          actor: req.user,
          workspaceBranchId: req.workspaceBranchId,
          workspaceViewAll: Boolean(req.workspaceViewAll),
        });
        res.status(r.ok ? 200 : 400).json(r);
      } catch (e) {
        console.error('[refund-company-retention/decide]', e);
        res.status(400).json({ ok: false, error: String(e.message || e) });
      }
    }
  );

  app.post(
    '/api/refund-company-retention/withdrawals/:id/pay',
    requirePermission(['finance.pay']),
    (req, res) => {
      try {
        const r = payCompanyRetentionWithdrawal(db, {
          ...(req.body || {}),
          withdrawalId: req.params.id,
          actor: req.user,
          workspaceBranchId: req.workspaceBranchId,
          workspaceViewAll: Boolean(req.workspaceViewAll),
        });
        res.status(r.ok ? 200 : 400).json(r);
      } catch (e) {
        console.error('[refund-company-retention/pay]', e);
        res.status(400).json({ ok: false, error: String(e.message || e) });
      }
    }
  );
}
