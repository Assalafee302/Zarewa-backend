/**
 * Refund claiming-staff directory — company employees with HR bank (masked).
 */
import { requirePermission } from '../auth.js';
import { resolveBootstrapBranchScope } from '../branchScope.js';
import { listClaimingStaffForRefunds } from '../sales/customerPayoutAccount.js';

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
}
