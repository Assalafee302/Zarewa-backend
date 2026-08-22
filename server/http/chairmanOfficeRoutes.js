/**
 * Chairman Office HTTP — company impact, drawings trail, loans, withdrawal requests.
 */
import { requireAuth } from '../auth.js';
import { apiError, apiForbidden } from '../apiError.js';
import { asyncRoute } from '../httpErrors.js';
import {
  requestChairmanOfficeLoan,
  recordChairmanOfficeLoanRepayment,
} from '../finance/chairmanOfficeLoansOps.js';
import {
  buildChairmanOffice,
  requestChairmanWithdrawal,
  userMayAccessChairmanOffice,
} from '../finance/chairmanOfficeOps.js';

function failResult(res, r) {
  const status = r.code === 'FORBIDDEN' ? 403 : r.code === 'NOT_FOUND' ? 404 : 400;
  return apiError(res, { status, code: r.code || 'REQUEST_FAILED', error: r.error });
}

/**
 * @param {import('express').Express} app
 * @param {object} db
 */
export function registerChairmanOfficeRoutes(app, db) {
  app.get(
    '/api/chairman/office',
    requireAuth,
    asyncRoute(
      async (req, res) => {
        if (!userMayAccessChairmanOffice(req.user)) {
          return apiForbidden(res, 'Chairman Office is limited to Chairman, MD, and Admin.');
        }
        const asOfIso = String(req.query?.asOfIso || '').trim() || undefined;
        const office = buildChairmanOffice(db, req.user, { asOfIso });
        return res.json({ ok: true, office });
      },
      { context: 'chairman.office', fallbackMessage: 'Could not load Chairman Office.' }
    )
  );

  app.post(
    '/api/chairman/withdrawals',
    requireAuth,
    asyncRoute(
      async (req, res) => {
        const r = requestChairmanWithdrawal(db, req.user, {
          ...(req.body || {}),
          workspaceBranchId: req.workspaceBranchId,
        });
        if (!r.ok) return failResult(res, r);
        return res.status(201).json(r);
      },
      { context: 'chairman.withdrawal', fallbackMessage: 'Could not create the withdrawal request.' }
    )
  );

  app.post(
    '/api/chairman/loans',
    requireAuth,
    asyncRoute(
      async (req, res) => {
        const r = requestChairmanOfficeLoan(db, req.user, {
          ...(req.body || {}),
          workspaceBranchId: req.workspaceBranchId,
        });
        if (!r.ok) return failResult(res, r);
        return res.status(201).json({
          ...r,
          office: buildChairmanOffice(db, req.user),
        });
      },
      { context: 'chairman.loan', fallbackMessage: 'Could not create the loan request.' }
    )
  );

  app.post(
    '/api/chairman/loans/:id/repay',
    requireAuth,
    asyncRoute(
      async (req, res) => {
        const r = recordChairmanOfficeLoanRepayment(db, req.user, req.params.id, req.body || {});
        if (!r.ok) return failResult(res, r);
        return res.json({
          ...r,
          office: buildChairmanOffice(db, req.user),
        });
      },
      { context: 'chairman.loan.repay', fallbackMessage: 'Could not record the loan repayment.' }
    )
  );
}
