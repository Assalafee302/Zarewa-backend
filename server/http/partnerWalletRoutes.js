/**
 * Partner wallet cashier APIs — list balances / open credits; withdraw full or partial.
 */
import { requirePermission } from '../auth.js';
import { resolveBootstrapBranchScope } from '../branchScope.js';
import {
  listPartnerWalletBalancesDue,
  listPartnerWalletOpenCredits,
  partnerWalletEnabled,
  withdrawPartnerWallet,
} from '../finance/partnerWalletOps.js';

/**
 * @param {import('express').Express} app
 * @param {object} db
 */
export function registerPartnerWalletRoutes(app, db) {
  app.get(
    '/api/partner-wallets',
    requirePermission(['finance.pay', 'cashier.desk.view', 'finance.view']),
    (req, res) => {
      try {
        const branchScope = resolveBootstrapBranchScope(req);
        res.json({
          ok: true,
          enabled: partnerWalletEnabled(),
          balances: listPartnerWalletBalancesDue(db, branchScope),
        });
      } catch (e) {
        console.error('[partner-wallets]', e);
        res.status(500).json({ ok: false, error: 'Failed to load partner wallets.' });
      }
    }
  );

  app.get(
    '/api/partner-wallets/:partyKind/:partyId/credits',
    requirePermission(['finance.pay', 'cashier.desk.view', 'finance.view']),
    (req, res) => {
      try {
        const branchScope = resolveBootstrapBranchScope(req);
        const credits = listPartnerWalletOpenCredits(
          db,
          req.params.partyKind,
          req.params.partyId,
          branchScope
        );
        res.json({ ok: true, credits });
      } catch (e) {
        console.error('[partner-wallet-credits]', e);
        res.status(500).json({ ok: false, error: 'Failed to load wallet credits.' });
      }
    }
  );

  app.post('/api/partner-wallets/withdraw', requirePermission('finance.pay'), (req, res) => {
    try {
      const branchScope = resolveBootstrapBranchScope(req);
      const r = withdrawPartnerWallet(db, {
        ...(req.body || {}),
        actor: req.user,
        workspaceBranchId: req.workspaceBranchId,
        workspaceViewAll: Boolean(req.workspaceViewAll),
        branchScope,
        paidBy: req.user?.displayName,
      });
      res.status(r.ok ? 201 : 400).json(r);
    } catch (e) {
      console.error('[partner-wallet-withdraw]', e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });
}
