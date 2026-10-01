/**
 * GET /api/reports/period-source
 * Full-period rows for Reports print preview (not the desk recent-N snapshot).
 */
import { requireAuth, userMayViewManagementReports } from '../auth.js';
import { apiError } from '../apiError.js';
import { asyncRoute } from '../httpErrors.js';
import { resolveBootstrapBranchScope } from '../branchScope.js';
import { loadReportPeriodSource } from '../finance/reportPeriodSourceOps.js';

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
export function registerReportPeriodSourceRoutes(app, db) {
  app.get(
    '/api/reports/period-source',
    requireManagementReportsView,
    asyncRoute(
      (req, res) => {
        const pack = loadReportPeriodSource(db, {
          startDate: req.query?.startDate,
          endDate: req.query?.endDate,
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
      { context: 'report-period-source', fallbackMessage: 'Could not load the report period.' }
    )
  );
}
