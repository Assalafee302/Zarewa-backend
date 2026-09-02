/**
 * Machine registry, dossier, and work-order envelope routes.
 * Existing list/create work-order handlers stay in httpApi.js until that composer is split.
 */
import { requireAuth, requirePermission } from '../auth.js';
import { resolveBootstrapBranchScope } from '../branchScope.js';
import { DEFAULT_BRANCH_ID } from '../branches.js';
import { asyncRoute } from '../httpErrors.js';
import { apiError } from '../apiError.js';
import { userMayEditMachines, userMayEditMaintenanceVendors } from '../../shared/maintenanceRegistry.js';
import {
  getMachineDossier,
  listMachineLinkableAssets,
  registerMachine,
  updateMachine,
} from '../operations/machineOps.js';
import {
  attachWorkOrderFinance,
  closeWorkOrderCosts,
  getMaintenanceWorkOrder,
  patchWorkOrderEnvelope,
  returnWorkOrderToProduction,
} from '../maintenanceWorkOrderOps.js';
import { createMaintenancePlan } from '../workItems.js';
import { createMachineFuelRequest } from '../operations/machineFuelOps.js';
import { openWorkOrderFromPlan, stampPlanService } from '../operations/maintenancePlanOps.js';
import {
  assertMachineIdInWorkspace,
  assertMaintenancePlanIdInWorkspace,
  assertMaintenanceWorkOrderIdInWorkspace,
} from '../workspaceBranchGuards.js';

function mayEditMachines(user) {
  const rk = String(user?.roleKey || user?.role_key || '')
    .trim()
    .toLowerCase();
  return userMayEditMachines(rk);
}

function mayEditWorkOrderMoney(user) {
  const rk = String(user?.roleKey || user?.role_key || '')
    .trim()
    .toLowerCase();
  return userMayEditMaintenanceVendors(rk) || rk === 'admin';
}

function branchScopeFromReq(req) {
  const branchScope = resolveBootstrapBranchScope(req);
  return {
    viewAll: branchScope === 'ALL',
    branchId: branchScope === 'ALL' ? req.workspaceBranchId || DEFAULT_BRANCH_ID : branchScope,
  };
}

/**
 * @param {import('express').Express} app
 * @param {object} db
 */
export function registerMaintenanceRoutes(app, db) {
  app.get(
    '/api/maintenance/machines/linkable-assets',
    requireAuth,
    requirePermission(['operations.view', 'operations.manage', 'reports.view']),
    asyncRoute(
      (req, res) => {
        const scope = branchScopeFromReq(req);
        res.json({ ok: true, assets: listMachineLinkableAssets(db, scope) });
      },
      { context: 'maintenance.assets', fallbackMessage: 'Could not load assets.' }
    )
  );

  app.post(
    '/api/maintenance/machines',
    requireAuth,
    asyncRoute(
      (req, res) => {
        if (!mayEditMachines(req.user)) {
          return apiError(res, {
            status: 403,
            code: 'FORBIDDEN',
            error: 'Only Branch Manager or above can register machines.',
          });
        }
        const r = registerMachine(db, req.body || {}, req.user, req.workspaceBranchId || DEFAULT_BRANCH_ID);
        res.status(r.ok ? 201 : 400).json(r);
      },
      { context: 'maintenance.machine.create', fallbackMessage: 'Could not register machine.' }
    )
  );

  app.patch(
    '/api/maintenance/machines/:machineId',
    requireAuth,
    asyncRoute(
      (req, res) => {
        if (!mayEditMachines(req.user)) {
          return apiError(res, {
            status: 403,
            code: 'FORBIDDEN',
            error: 'Only Branch Manager or above can edit machines.',
          });
        }
        const gate = assertMachineIdInWorkspace(db, req, req.params.machineId);
        if (!gate.ok) return res.status(gate.status).json({ ok: false, error: gate.error });
        const r = updateMachine(db, req.params.machineId, req.body || {}, req.user);
        res.status(r.ok ? 200 : 400).json(r);
      },
      { context: 'maintenance.machine.update', fallbackMessage: 'Could not update machine.' }
    )
  );

  app.get(
    '/api/maintenance/machines/:machineId/dossier',
    requireAuth,
    requirePermission(['operations.view', 'operations.manage', 'reports.view']),
    asyncRoute(
      (req, res) => {
        const pack = getMachineDossier(db, req.params.machineId, branchScopeFromReq(req));
        res.status(pack.ok ? 200 : 404).json(pack);
      },
      { context: 'maintenance.dossier', fallbackMessage: 'Could not load machine dossier.' }
    )
  );

  app.get(
    '/api/maintenance/work-orders/:workOrderId/finance',
    requireAuth,
    requirePermission(['operations.view', 'operations.manage', 'reports.view']),
    asyncRoute(
      (req, res) => {
        const gate = assertMaintenanceWorkOrderIdInWorkspace(db, req, req.params.workOrderId);
        if (!gate.ok) return res.status(gate.status).json({ ok: false, error: gate.error });
        const wo = getMaintenanceWorkOrder(db, req.params.workOrderId);
        if (!wo) return apiError(res, { status: 404, code: 'NOT_FOUND', error: 'Work order not found.' });
        res.json({ ok: true, ...attachWorkOrderFinance(db, wo) });
      },
      { context: 'maintenance.wo.finance', fallbackMessage: 'Could not load work-order spend.' }
    )
  );

  app.patch(
    '/api/maintenance/work-orders/:workOrderId/envelope',
    requireAuth,
    asyncRoute(
      (req, res) => {
        if (!mayEditWorkOrderMoney(req.user)) {
          return apiError(res, { status: 403, code: 'FORBIDDEN', error: 'Branch Manager or above required.' });
        }
        const gate = assertMaintenanceWorkOrderIdInWorkspace(db, req, req.params.workOrderId);
        if (!gate.ok) return res.status(gate.status).json({ ok: false, error: gate.error });
        const r = patchWorkOrderEnvelope(db, req.params.workOrderId, req.body || {}, req.user);
        res.status(r.ok ? 200 : 400).json(r);
      },
      { context: 'maintenance.wo.envelope', fallbackMessage: 'Could not update envelope.' }
    )
  );

  app.post(
    '/api/maintenance/work-orders/:workOrderId/return-to-production',
    requireAuth,
    asyncRoute(
      (req, res) => {
        if (!mayEditWorkOrderMoney(req.user)) {
          return apiError(res, { status: 403, code: 'FORBIDDEN', error: 'Branch Manager or above required.' });
        }
        const gate = assertMaintenanceWorkOrderIdInWorkspace(db, req, req.params.workOrderId);
        if (!gate.ok) return res.status(gate.status).json({ ok: false, error: gate.error });
        const r = returnWorkOrderToProduction(db, req.params.workOrderId, req.body || {}, req.user);
        res.status(r.ok ? 200 : 400).json(r);
      },
      { context: 'maintenance.wo.return', fallbackMessage: 'Could not return machine to production.' }
    )
  );

  app.post(
    '/api/maintenance/work-orders/:workOrderId/close-costs',
    requireAuth,
    asyncRoute(
      (req, res) => {
        if (!mayEditWorkOrderMoney(req.user)) {
          return apiError(res, { status: 403, code: 'FORBIDDEN', error: 'Branch Manager or above required.' });
        }
        const gate = assertMaintenanceWorkOrderIdInWorkspace(db, req, req.params.workOrderId);
        if (!gate.ok) return res.status(gate.status).json({ ok: false, error: gate.error });
        const r = closeWorkOrderCosts(db, req.params.workOrderId, req.body || {}, req.user);
        res.status(r.ok ? 200 : 400).json(r);
      },
      { context: 'maintenance.wo.closeCosts', fallbackMessage: 'Could not close maintenance costs.' }
    )
  );

  app.post(
    '/api/maintenance/fuel-requests',
    requireAuth,
    requirePermission(['operations.manage', 'expenses.create']),
    asyncRoute(
      (req, res) => {
        const r = createMachineFuelRequest(
          db,
          req.body || {},
          req.user,
          req.workspaceBranchId || DEFAULT_BRANCH_ID
        );
        res.status(r.ok ? 201 : 400).json(r);
      },
      { context: 'maintenance.fuel', fallbackMessage: 'Could not submit the diesel request.' }
    )
  );

  app.post(
    '/api/maintenance/plans',
    requireAuth,
    asyncRoute(
      (req, res) => {
        if (!mayEditMachines(req.user)) {
          return apiError(res, {
            status: 403,
            code: 'FORBIDDEN',
            error: 'Only Branch Manager or above can create service plans.',
          });
        }
        const machineGate = assertMachineIdInWorkspace(db, req, req.body?.machineId);
        if (!machineGate.ok) return res.status(machineGate.status).json({ ok: false, error: machineGate.error });
        const r = createMaintenancePlan(
          db,
          req.body || {},
          req.user,
          req.workspaceBranchId || DEFAULT_BRANCH_ID
        );
        res.status(r.ok ? 201 : 400).json(r);
      },
      { context: 'maintenance.plan.create', fallbackMessage: 'Could not create the service plan.' }
    )
  );

  app.post(
    '/api/maintenance/plans/:planId/open-work-order',
    requireAuth,
    asyncRoute(
      (req, res) => {
        if (!mayEditMachines(req.user)) {
          return apiError(res, {
            status: 403,
            code: 'FORBIDDEN',
            error: 'Only Branch Manager or above can open a service job.',
          });
        }
        const gate = assertMaintenancePlanIdInWorkspace(db, req, req.params.planId);
        if (!gate.ok) return res.status(gate.status).json({ ok: false, error: gate.error });
        const r = openWorkOrderFromPlan(
          db,
          req.params.planId,
          req.user,
          req.workspaceBranchId || DEFAULT_BRANCH_ID
        );
        res.status(r.ok ? 201 : 400).json(r);
      },
      { context: 'maintenance.plan.openWo', fallbackMessage: 'Could not open the service job.' }
    )
  );

  app.post(
    '/api/maintenance/plans/:planId/complete-service',
    requireAuth,
    asyncRoute(
      (req, res) => {
        if (!mayEditMachines(req.user)) {
          return apiError(res, {
            status: 403,
            code: 'FORBIDDEN',
            error: 'Only Branch Manager or above can stamp a service as done.',
          });
        }
        const gate = assertMaintenancePlanIdInWorkspace(db, req, req.params.planId);
        if (!gate.ok) return res.status(gate.status).json({ ok: false, error: gate.error });
        const r = stampPlanService(db, req.params.planId, req.body || {}, req.user);
        res.status(r.ok ? 200 : 400).json(r);
      },
      { context: 'maintenance.plan.complete', fallbackMessage: 'Could not record the service.' }
    )
  );
}
