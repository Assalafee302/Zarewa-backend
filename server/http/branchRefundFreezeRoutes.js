/**
 * Admin per-branch refund lock window (quotations and receipts in a from–to date range).
 */
import { requireAuth } from '../auth.js';
import { apiError } from '../apiError.js';
import { loadBranchRefundFreeze } from '../sales/branchRefundFreeze.js';
import { setBranchRefundsBlocked } from '../sales/branchRefundFreezeOps.js';

/**
 * @param {import('express').Express} app
 * @param {object} db
 */
export function registerBranchRefundFreezeRoutes(app, db) {
  app.get('/api/branches/:id/refunds-blocked', requireAuth, (req, res) => {
    try {
      const bid = String(req.params.id ?? '').trim();
      if (!bid) return apiError(res, { status: 400, code: 'VALIDATION_ERROR', error: 'Branch id is required.' });
      const freeze = loadBranchRefundFreeze(db, bid);
      if (!freeze) return apiError(res, { status: 404, code: 'NOT_FOUND', error: 'Branch not found.' });
      return res.json({ ok: true, ...freeze });
    } catch (e) {
      console.error('[branch refunds-blocked get]', e);
      return apiError(res, { status: 500, error: 'Could not load branch refund freeze.' });
    }
  });

  app.patch('/api/branches/:id/refunds-blocked', requireAuth, (req, res) => {
    try {
      const bid = String(req.params.id ?? '').trim();
      const r = setBranchRefundsBlocked(db, bid, req.body || {}, req.user);
      if (!r.ok && r.code === 'FORBIDDEN') {
        return apiError(res, { status: 403, code: 'FORBIDDEN', error: r.error });
      }
      return res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error('[branch refunds-blocked patch]', e);
      return apiError(res, { status: 500, error: 'Could not update branch refund freeze.' });
    }
  });
}
