/**
 * GET  /api/treasury/integrity — finance.view. Report-only stored vs computed.
 * POST /api/treasury/accounts/:id/strict-cache — Admin/MD only, reason required; on only at ₦0 difference.
 */
import { requireAuth, requirePermission } from '../auth.js';
import { apiError } from '../apiError.js';
import { resolveBootstrapBranchScope } from '../branchScope.js';
import {
  buildTreasuryBalanceIntegrityReport,
  setTreasuryAccountStrictCache,
} from '../finance/treasuryBalanceIntegrityOps.js';

/**
 * @param {import('express').Express} app
 * @param {object} db
 */
export function registerTreasuryBalanceIntegrityRoutes(app, db) {
  app.get('/api/treasury/integrity', requirePermission('finance.view'), (req, res) => {
    try {
      const workspaceScope = resolveBootstrapBranchScope(req);
      const qBranch = String(req.query?.branchId || '').trim();
      const branchId =
        workspaceScope !== 'ALL' ? workspaceScope : qBranch && qBranch !== 'ALL' ? qBranch : 'ALL';
      const persist = String(req.query?.persist || '').trim() === '1';
      const report = buildTreasuryBalanceIntegrityReport(db, { branchId, persist });
      return res.json(report);
    } catch (e) {
      console.error('[treasury-integrity]', e);
      return apiError(res, {
        status: 500,
        code: 'TREASURY_INTEGRITY_FAILED',
        error: 'Could not load treasury balance integrity.',
      });
    }
  });

  app.post('/api/treasury/accounts/:id/strict-cache', requireAuth, (req, res) => {
    try {
      const r = setTreasuryAccountStrictCache(
        db,
        req.params.id,
        { enabled: req.body?.enabled === true, reason: req.body?.reason },
        req.user
      );
      if (!r.ok) {
        return apiError(res, {
          status: r.status || 400,
          code: r.status === 403 ? 'FORBIDDEN' : 'TREASURY_STRICT_CACHE_REFUSED',
          error: r.error,
        });
      }
      return res.json(r);
    } catch (e) {
      console.error('[treasury-strict-cache]', e);
      return apiError(res, {
        status: 500,
        code: 'TREASURY_STRICT_CACHE_FAILED',
        error: 'Could not change strict balance checking.',
      });
    }
  });
}
