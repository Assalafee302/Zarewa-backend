/**
 * GET /api/reports/sales-month-end-pack
 * Read-only. Permission matches the other management reports.
 */
import { requireAuth, userMayViewManagementReports } from '../auth.js';
import { apiError } from '../apiError.js';
import { asyncRoute } from '../httpErrors.js';
import { resolveBootstrapBranchScope } from '../branchScope.js';
import { buildSimpleTextPdf } from '../../shared/lib/simpleTextPdf.js';
import {
  salesMonthEndPackFilename,
  salesMonthEndPackToCsv,
  salesMonthEndPackToPdfPages,
} from '../../shared/lib/salesMonthEndPack.js';
import { buildSalesMonthEndPackFromDb } from '../finance/salesMonthEndPackOps.js';

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
export function registerSalesMonthEndPackRoutes(app, db) {
  app.get(
    '/api/reports/sales-month-end-pack',
    requireManagementReportsView,
    asyncRoute(
      (req, res) => {
        const pack = buildSalesMonthEndPackFromDb(db, {
          month: req.query?.month,
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
        const format = String(req.query?.format || 'json').trim().toLowerCase();
        if (format === 'pdf') {
          const pdf = buildSimpleTextPdf(salesMonthEndPackToPdfPages(pack));
          const filename = salesMonthEndPackFilename(pack, 'pdf');
          res.setHeader('Content-Type', 'application/pdf');
          res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
          return res.send(Buffer.from(pdf));
        }
        if (format === 'csv') {
          const filename = salesMonthEndPackFilename(pack, 'csv');
          res.setHeader('Content-Type', 'text/csv; charset=utf-8');
          res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
          return res.send(salesMonthEndPackToCsv(pack));
        }
        return res.json(pack);
      },
      { context: 'sales-month-end-pack', fallbackMessage: 'Could not build the month-end sales pack.' }
    )
  );
}
