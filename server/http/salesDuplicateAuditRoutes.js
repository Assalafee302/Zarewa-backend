/**
 * Read-only sales chain duplicate audit (outage / network-retry twins).
 *
 * @param {import('express').Express} app
 * @param {object} db
 */
import { requireAuth, userMayViewManagementReports } from '../auth.js';
import { resolveBootstrapBranchScope } from '../branchScope.js';
import { buildOutageDuplicateAuditReport } from '../sales/outageDuplicateAuditOps.js';

export function registerSalesDuplicateAuditRoutes(app, db) {
  /**
   * Quotation → receipt → cutting list → production duplicate suspects for a date window.
   * Query: fromDate, toDate (YYYY-MM-DD), or days (default 14); optional limit.
   */
  app.get('/api/reports/outage-duplicate-audit', requireAuth, (req, res) => {
    try {
      if (!userMayViewManagementReports(req.user)) {
        return res.status(403).json({
          ok: false,
          error: 'You do not have permission for this action.',
          code: 'FORBIDDEN',
        });
      }
      const branchScope = resolveBootstrapBranchScope(req);
      const report = buildOutageDuplicateAuditReport(db, {
        branchScope,
        fromDate: req.query?.fromDate || req.query?.from,
        toDate: req.query?.toDate || req.query?.to,
        days: Number(req.query?.days) || undefined,
        limit: Number(req.query?.limit) || undefined,
      });
      return res.json(report);
    } catch (e) {
      console.error('[outage-duplicate-audit]', e);
      return res.status(500).json({ ok: false, error: 'Could not build outage duplicate audit.' });
    }
  });
}
