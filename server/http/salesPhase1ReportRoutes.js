/**
 * GET /api/reports/sales-phase1
 * Phase 1 revenue, cash, advances/debtors, and the monthly bridge.
 * Does not change the Management report.
 */
import { requireAuth, userMayViewManagementReports } from '../auth.js';
import { apiError } from '../apiError.js';
import { asyncRoute } from '../httpErrors.js';
import { resolveBootstrapBranchScope } from '../branchScope.js';
import { buildSalesPhase1ReportFromDb } from '../sales/salesPhase1ReportOps.js';

function requireManagementReportsView(req, res, next) {
  requireAuth(req, res, (err) => {
    if (err) return next(err);
    if (res.headersSent) return;
    if (!req.user || !userMayViewManagementReports(req.user)) {
      return res.status(req.user ? 403 : 401).json({
        ok: false,
        error: req.user ? 'You do not have permission for this action.' : 'Sign in required.',
        code: req.user ? 'FORBIDDEN' : 'AUTH_REQUIRED',
      });
    }
    return next();
  });
}

/**
 * @param {import('express').Express} app
 * @param {object} db
 */
export function registerSalesPhase1ReportRoutes(app, db) {
  app.get(
    '/api/reports/sales-phase1',
    requireManagementReportsView,
    asyncRoute(
      (req, res) => {
        const pack = buildSalesPhase1ReportFromDb(db, {
          month: req.query?.month,
          startDate: req.query?.startDate,
          endDate: req.query?.endDate,
          openingAsAt: req.query?.openingAsAt,
          closingAsAt: req.query?.closingAsAt,
          branchScope: resolveBootstrapBranchScope(req),
        });
        if (!pack.ok) {
          return apiError(res, {
            status: 400,
            code: 'VALIDATION_ERROR',
            error: pack.error || 'Invalid period.',
          });
        }
        return res.json(pack);
      },
      { context: 'sales-phase1', fallbackMessage: 'Could not build the Phase 1 sales report.' }
    )
  );
}
