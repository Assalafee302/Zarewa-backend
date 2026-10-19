/**
 * Phase 3 controls — read-only lists: balance due after production, locked-period changes.
 */
import { requirePermission } from '../auth.js';
import { resolveBootstrapBranchScope } from '../branchScope.js';
import { listBalanceDueAfterProduction, listLockedPeriodChanges } from '../controlsPhase3Ops.js';

export function registerControlsPhase3Routes(app, db) {
  app.get(
    '/api/controls/balance-due-after-production',
    requirePermission(['reports.view', 'finance.view', 'sales.manage', 'production.manage']),
    (req, res) => {
      try {
        res.json({ ok: true, ...listBalanceDueAfterProduction(db, resolveBootstrapBranchScope(req)) });
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: String(e.message || e) });
      }
    }
  );

  app.get(
    '/api/controls/locked-period-changes',
    requirePermission(['audit.view', 'period.manage', 'finance.view']),
    (req, res) => {
      try {
        res.json({
          ok: true,
          ...listLockedPeriodChanges(db, {
            fromISO: req.query?.from,
            toISO: req.query?.to,
            limit: req.query?.limit,
          }),
        });
      } catch (e) {
        console.error(e);
        res.status(500).json({ ok: false, error: String(e.message || e) });
      }
    }
  );
}
