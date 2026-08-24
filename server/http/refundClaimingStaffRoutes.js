/**
 * Refund claiming-staff directory + inline payout bank capture.
 */
import { requirePermission } from '../auth.js';
import { resolveBootstrapBranchScope } from '../branchScope.js';
import { DEFAULT_BRANCH_ID } from '../branches.js';
import { listClaimingStaffForRefunds } from '../sales/customerPayoutAccount.js';
import { saveRefundPayoutBank } from '../sales/refundPayoutBankOps.js';

/**
 * @param {import('express').Express} app
 * @param {object} db
 */
export function registerRefundClaimingStaffRoutes(app, db) {
  app.get(
    '/api/refunds/claiming-staff',
    requirePermission(['refunds.request', 'refunds.approve', 'finance.approve']),
    (req, res) => {
      try {
        const branchScope = resolveBootstrapBranchScope(req);
        const claimingStaff = listClaimingStaffForRefunds(db, branchScope);
        res.json({ ok: true, claimingStaff });
      } catch (e) {
        console.error('[refunds/claiming-staff]', e);
        res.status(500).json({ ok: false, error: 'Failed to load claiming staff.' });
      }
    }
  );

  /** Capture bank on customer / associated staff without leaving the refund form. */
  app.post(
    '/api/refunds/payout-bank',
    requirePermission(['refunds.request', 'refunds.approve', 'finance.approve', 'customers.manage']),
    (req, res) => {
      try {
        const body = req.body || {};
        const r = saveRefundPayoutBank(db, {
          ...body,
          branchId: req.workspaceBranchId || DEFAULT_BRANCH_ID,
        });
        if (!r.ok) return res.status(400).json(r);
        res.json(r);
      } catch (e) {
        console.error('[refunds/payout-bank]', e);
        res.status(500).json({ ok: false, error: 'Failed to save payout bank.' });
      }
    }
  );
}
