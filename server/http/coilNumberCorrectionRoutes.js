/**
 * Store submits a wrong coil number. Branch manager approval applies the rename.
 */
import { requireAuth, requirePermission, userHasPermission } from '../auth.js';
import { resolveBootstrapBranchScope } from '../branchScope.js';
import {
  decideCoilNumberCorrection,
  listCoilNumberCorrections,
  requestCoilNumberCorrection,
  userMayApproveCoilNumberCorrection,
} from '../operations/coilNumberCorrectionOps.js';

function maySeeCorrections(user) {
  return userMayApproveCoilNumberCorrection(user) || userHasPermission(user, 'inventory.receive');
}

export function registerCoilNumberCorrectionRoutes(app, db) {
  app.get('/api/coil-number-corrections', requireAuth, (req, res) => {
    try {
      if (!maySeeCorrections(req.user)) {
        return res.status(403).json({ ok: false, error: 'You cannot view coil number corrections.' });
      }
      const branchScope = resolveBootstrapBranchScope(req);
      const corrections = listCoilNumberCorrections(db, branchScope, {
        status: req.query?.status || 'pending',
        fromCoilNo: req.query?.fromCoilNo || req.query?.coilNo || '',
      });
      res.json({ ok: true, corrections });
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });

  app.post(
    '/api/coil-lots/:coilNo/number-correction',
    requirePermission('inventory.receive'),
    (req, res) => {
      try {
        const r = requestCoilNumberCorrection(db, req.params.coilNo, req.body || {}, {
          actor: req.user,
          workspaceBranchId: req.workspaceBranchId,
        });
        res.status(r.ok ? 201 : 400).json(r);
      } catch (e) {
        console.error(e);
        res.status(400).json({ ok: false, error: String(e.message || e) });
      }
    }
  );

  app.post('/api/coil-number-corrections/:id/decision', requireAuth, (req, res) => {
    try {
      if (!userMayApproveCoilNumberCorrection(req.user)) {
        return res.status(403).json({
          ok: false,
          error: 'Only a branch manager (or above) can approve a coil number correction.',
        });
      }
      const r = decideCoilNumberCorrection(db, req.params.id, req.body || {}, {
        actor: req.user,
        workspaceBranchId: req.workspaceBranchId,
        workspaceViewAll: Boolean(req.workspaceViewAll),
      });
      res.status(r.ok ? 200 : 400).json(r);
    } catch (e) {
      console.error(e);
      res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  });
}
