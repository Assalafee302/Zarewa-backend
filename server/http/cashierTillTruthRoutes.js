import { requirePermission } from '../auth.js';
import { apiError } from '../apiError.js';
import { resolveBootstrapBranchScope } from '../branchScope.js';
import { buildCashierTillTruth } from '../finance/cashierTillTruthOps.js';

const TILL_TRUTH_PERMS = ['cashier.desk.view', 'finance.view', 'finance.pay', 'finance.post'];

/**
 * @param {import('express').Express} app
 * @param {object} db
 */
export function registerCashierTillTruthRoutes(app, db) {
  app.get('/api/cashier/till-truth', requirePermission(TILL_TRUTH_PERMS), (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      const tillTruth = buildCashierTillTruth(db, branchScope);
      res.json({ ok: true, tillTruth });
    } catch (e) {
      console.error(e);
      return apiError(res, { status: 500, code: 'TILL_TRUTH_FAILED', error: 'Could not load till balances.' });
    }
  });
}
