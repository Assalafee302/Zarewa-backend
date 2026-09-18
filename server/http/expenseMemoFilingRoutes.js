/**
 * Monthly stacked expense-memo filing pack (JSON / PDF / CSV).
 * Print several memos per A4 sheet, grouped by category, instead of one page each.
 */
import { requirePermission } from '../auth.js';
import { apiError } from '../apiError.js';
import { asyncRoute } from '../httpErrors.js';
import { resolveBootstrapBranchScope } from '../branchScope.js';
import { CASHIER_DESK_PERMS, FINANCE_DOMAIN_PERMS } from '../workspaceAccess.js';
import { buildSimpleTextPdf } from '../../shared/lib/simpleTextPdf.js';
import {
  filingPackFilename,
  filingPackToCsv,
  filingPackToPdfPages,
} from '../../shared/lib/expenseMemoFilingPack.js';
import { buildExpenseMemoFilingPackFromDb } from '../finance/expenseMemoFilingOps.js';

const FILING_PACK_PERMS = [
  ...FINANCE_DOMAIN_PERMS,
  ...CASHIER_DESK_PERMS,
  'reports.view',
  'manager.dashboard',
];

/**
 * @param {import('express').Express} app
 * @param {object} db
 */
export function registerExpenseMemoFilingRoutes(app, db) {
  app.get(
    '/api/reports/expense-memo-filing-pack',
    requirePermission(FILING_PACK_PERMS),
    asyncRoute(
      (req, res) => {
        const branchScope = resolveBootstrapBranchScope(req);
        const pack = buildExpenseMemoFilingPackFromDb(db, {
          month: req.query?.month,
          startDate: req.query?.startDate,
          endDate: req.query?.endDate,
          branchScope,
          status: req.query?.status,
          dateBasis: req.query?.dateBasis,
          category: req.query?.category,
          categoryLane: req.query?.categoryLane || req.query?.lane,
          includeUnlinked: req.query?.includeUnlinked,
          includeOfficeBody: req.query?.includeOfficeBody,
          pageBreakBeforeCategory: req.query?.pageBreakBeforeCategory,
        });
        if (!pack.ok) {
          return apiError(res, {
            status: 400,
            code: pack.code || 'VALIDATION_ERROR',
            error: pack.error || 'Invalid filing period.',
          });
        }
        const format = String(req.query?.format || 'json').trim().toLowerCase();
        if (format === 'pdf') {
          const pages = filingPackToPdfPages(pack);
          const pdf = buildSimpleTextPdf(pages);
          const filename = filingPackFilename(pack, 'pdf');
          res.setHeader('Content-Type', 'application/pdf');
          res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
          return res.send(Buffer.from(pdf));
        }
        if (format === 'csv') {
          const csv = filingPackToCsv(pack);
          const filename = filingPackFilename(pack, 'csv');
          res.setHeader('Content-Type', 'text/csv; charset=utf-8');
          res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
          return res.send(csv);
        }
        return res.json(pack);
      },
      { context: 'expense-memo-filing-pack', fallbackMessage: 'Could not build the expense filing pack.' }
    )
  );
}
