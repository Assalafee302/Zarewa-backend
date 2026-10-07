/**
 * GET/POST /api/reports/month-end-data-pack
 * Read-only figures for the accounts book. Does not post or prepare accounts.
 */
import XLSX from 'xlsx';
import { requireAuth, userMayViewManagementReports } from '../auth.js';
import { apiError } from '../apiError.js';
import { asyncRoute } from '../httpErrors.js';
import { resolveBootstrapBranchScope } from '../branchScope.js';
import { monthEndPackFilename, monthEndPackToSheets } from '../../shared/lib/monthEndDataPack.js';
import { buildMonthEndDataPackFromDb } from '../finance/monthEndDataPackOps.js';

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

function branchForPack(req) {
  const requested = String(req.query?.branch || req.body?.branchId || '').trim();
  if (/^BR-[A-Za-z0-9-]+$/.test(requested)) return requested;
  const scope = resolveBootstrapBranchScope(req);
  return scope && scope !== 'ALL' ? scope : '';
}

function inputsFrom(req) {
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const bookPrices = body.bookPrices || {};
  return {
    bookPrices: {
      aluminium: bookPrices.aluminium ?? req.query?.bookPriceAluminium,
      aluzinc: bookPrices.aluzinc ?? req.query?.bookPriceAluzinc,
    },
    counts: Array.isArray(body.counts) ? body.counts : [],
    accessoryCosts: body.accessoryCosts || {},
    cashCountNgn: body.cashCountNgn ?? req.query?.cashCountNgn,
    bankStatements: body.bankStatements || {},
  };
}

function sendPack(res, pack, format) {
  if (format === 'xlsx') {
    const wb = XLSX.utils.book_new();
    for (const sheet of monthEndPackToSheets(pack)) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheet.rows), sheet.name);
    }
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${monthEndPackFilename(pack)}"`);
    return res.send(Buffer.from(buf));
  }
  return res.json(pack);
}

/**
 * @param {import('express').Express} app
 * @param {object} db
 */
export function registerMonthEndDataPackRoutes(app, db) {
  const handler = asyncRoute(
    (req, res) => {
      const branchId = branchForPack(req);
      if (!branchId) {
        return apiError(res, {
          status: 400,
          code: 'VALIDATION_ERROR',
          error: 'Choose one branch. This pack is not an all-branches roll-up.',
        });
      }
      const pack = buildMonthEndDataPackFromDb(db, {
        branchId,
        month: req.query?.month || req.body?.month,
        ...inputsFrom(req),
      });
      if (!pack.ok) {
        return apiError(res, {
          status: 400,
          code: 'VALIDATION_ERROR',
          error: pack.error || 'Invalid period.',
        });
      }
      return sendPack(res, pack, String(req.query?.format || 'json').trim().toLowerCase());
    },
    { context: 'month-end-data-pack', fallbackMessage: 'Could not build the month-end data pack.' }
  );
  app.get('/api/reports/month-end-data-pack', requireManagementReportsView, handler);
  app.post('/api/reports/month-end-data-pack', requireManagementReportsView, handler);
}
