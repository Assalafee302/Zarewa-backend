/**
 * Cashier acknowledgment of MD purchase / AP supplier payments (bookkeeping only).
 */
import { requirePermission } from '../auth.js';
import { withWriteDelta } from '../workspaceWriteDelta.js';
import {
  acknowledgePurchasePaymentCashierAck,
  getPurchasePaymentCashierAck,
  listPurchasePaymentCashierAcksPending,
} from '../finance/purchasePaymentCashierAckOps.js';
import { resolveBootstrapBranchScope } from '../branchScope.js';

/**
 * @param {import('express').Express} app
 * @param {object} db
 */
export function registerPurchasePaymentCashierAckRoutes(app, db) {
  app.get(
    '/api/purchase-payment-cashier-acks/pending',
    requirePermission(['cashier.receipts.confirm', 'finance.pay', 'cashier.desk.view']),
    (req, res) => {
      try {
        const branchScope = resolveBootstrapBranchScope(req);
        res.json({
          ok: true,
          rows: listPurchasePaymentCashierAcksPending(db, branchScope),
        });
      } catch (e) {
        console.error('[purchase-payment-cashier-acks]', e);
        res.status(500).json({ ok: false, error: 'Failed to load purchase payment acknowledgments.' });
      }
    }
  );

  app.patch(
    '/api/purchase-payment-cashier-acks/:ackId/acknowledge',
    requirePermission(['cashier.receipts.confirm', 'finance.pay']),
    (req, res) => {
      try {
        const ackId = String(req.params.ackId || '').trim();
        const r = acknowledgePurchasePaymentCashierAck(db, ackId, {
          actor: req.user,
          note: req.body?.note,
          workspaceBranchId: req.workspaceBranchId,
          workspaceViewAll: Boolean(req.workspaceViewAll),
        });
        if (!r.ok) {
          const status = r.status === 403 ? 403 : 400;
          return res.status(status).json({ ok: false, error: r.error });
        }
        const pending = listPurchasePaymentCashierAcksPending(db, resolveBootstrapBranchScope(req));
        // Include acknowledged row so clients can drop it from pending lists by id/status.
        const ack = r.ack || getPurchasePaymentCashierAck(db, ackId);
        return res.json(
          withWriteDelta(
            { ok: true, alreadyAcknowledged: Boolean(r.alreadyAcknowledged), ack },
            {
              purchasePaymentCashierAcksPending: pending,
              purchasePaymentCashierAck: ack ? [ack] : [],
            }
          )
        );
      } catch (e) {
        console.error('[purchase-payment-cashier-ack]', e);
        res.status(500).json({ ok: false, error: 'Could not acknowledge purchase payment.' });
      }
    }
  );
}
