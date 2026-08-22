/**
 * Plant machine registry: create/update the machine file and the BM/MD dossier.
 */
import { appendAuditLog } from '../controlOps.js';
import { createMachine, linkMachineAsset, listMachineLinkableAssets, listMachines } from '../workItems.js';
import { buildMaintenanceMachineInsights } from '../maintenanceInsightsOps.js';
import { attachWorkOrderFinance, listMaintenanceEventsForMachine, listWorkOrdersForMachine } from '../maintenanceWorkOrderOps.js';
import { MACHINE_STATUSES, MACHINE_TYPES } from '../../shared/maintenanceRegistry.js';

function nowIso() {
  return new Date().toISOString();
}

function normalizeMachineStatus(raw) {
  const s = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, '_');
  if (MACHINE_STATUSES.includes(s)) return s;
  return 'active';
}

function normalizeMachineType(raw) {
  const s = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, '_');
  if (MACHINE_TYPES.includes(s)) return s;
  return s || '';
}

export function getMachine(db, machineId) {
  const id = String(machineId || '').trim();
  if (!id) return null;
  const row = db.prepare(`SELECT * FROM machines WHERE id = ?`).get(id);
  if (!row) return null;
  const listed = listMachines(db, { viewAll: true, branchId: row.branch_id });
  return listed.find((m) => m.id === id) || null;
}

export function updateMachine(db, machineId, body, actor) {
  const current = db.prepare(`SELECT * FROM machines WHERE id = ?`).get(String(machineId || '').trim());
  if (!current) return { ok: false, error: 'Machine not found.' };
  const name = body?.name != null ? String(body.name || '').trim() : current.name;
  if (!name) return { ok: false, error: 'Machine name is required.' };
  const status = body?.status != null ? normalizeMachineStatus(body.status) : current.status;
  const machineType =
    body?.machineType != null ? normalizeMachineType(body.machineType) : current.machine_type;
  db.prepare(
    `UPDATE machines SET
       name = ?, machine_code = ?, line_name = ?, machine_type = ?, status = ?,
       asset_category = ?, serial_no = ?, model_no = ?, manufacturer = ?,
       installed_at_iso = ?, commissioned_at_iso = ?, notes = ?,
       updated_at_iso = ?, updated_by_user_id = ?
     WHERE id = ?`
  ).run(
    name,
    body?.machineCode != null ? String(body.machineCode || '').trim() || null : current.machine_code,
    body?.lineName != null ? String(body.lineName || '').trim() || null : current.line_name,
    machineType || null,
    status,
    body?.assetCategory != null ? String(body.assetCategory || '').trim() || null : current.asset_category,
    body?.serialNo != null ? String(body.serialNo || '').trim() || null : current.serial_no,
    body?.modelNo != null ? String(body.modelNo || '').trim() || null : current.model_no,
    body?.manufacturer != null ? String(body.manufacturer || '').trim() || null : current.manufacturer,
    body?.installedAtIso != null ? String(body.installedAtIso || '').trim() || null : current.installed_at_iso,
    body?.commissionedAtIso != null
      ? String(body.commissionedAtIso || '').trim() || null
      : current.commissioned_at_iso,
    body?.notes != null ? String(body.notes || '').trim() || null : current.notes,
    nowIso(),
    String(actor?.id || '').trim() || null,
    current.id
  );
  const assetId = body?.assetId != null ? String(body.assetId || '').trim() : '';
  if (body?.assetId != null && assetId) {
    const linked = linkMachineAsset(db, current.id, assetId, actor, 'primary');
    if (!linked.ok) return linked;
  }
  appendAuditLog(db, {
    actor,
    action: 'machine.update',
    entityKind: 'machine',
    entityId: current.id,
    note: name,
  });
  return { ok: true, machine: getMachine(db, current.id) };
}

export function registerMachine(db, body, actor, workspaceBranchId) {
  const status = normalizeMachineStatus(body?.status);
  const machineType = normalizeMachineType(body?.machineType);
  const created = createMachine(
    db,
    { ...body, status, machineType },
    actor,
    workspaceBranchId
  );
  if (!created.ok) return created;
  const assetId = String(body?.assetId || '').trim();
  if (assetId) {
    const linked = linkMachineAsset(db, created.machineId, assetId, actor, 'primary');
    if (!linked.ok) return { ...created, assetLinkError: linked.error };
  }
  return { ok: true, machineId: created.machineId, machine: getMachine(db, created.machineId) };
}

function workOrderStillActive(wo) {
  const st = String(wo?.status || '').toLowerCase();
  if (st === 'cancelled' || st === 'rejected') return false;
  const env = wo?.envelope;
  if (env && (env.shopFloorOpen != null || env.costOpen != null)) {
    return Boolean(env.shopFloorOpen || env.costOpen);
  }
  return st !== 'closed';
}

/**
 * Next steps for BM on this machine — shown on the machine-file popup.
 * @param {{ status?: string }} machine
 * @param {Array<object>} workOrders
 */
export function buildMachineDossierNextActions(machine, workOrders) {
  const actions = [];
  const open = (Array.isArray(workOrders) ? workOrders : []).filter(workOrderStillActive);
  for (const wo of open) {
    const env = wo.envelope || {};
    const ref = wo.referenceNo || wo.id;
    const symptom = wo.symptom || wo.summary || 'Fault';
    if (!wo.acknowledgedAtIso) {
      actions.push({
        key: 'acknowledge',
        workOrderId: wo.id,
        title: 'Acknowledge this fault',
        detail: `${ref}: ${symptom}. Confirms you have seen it.`,
      });
    }
    if (!wo.assignedToUserId && !wo.vendorId) {
      actions.push({
        key: 'assign',
        workOrderId: wo.id,
        title: 'Assign a technician or vendor',
        detail: `${ref} has nobody assigned yet.`,
      });
    }
    if (!(Number(wo.estimatedCostNgn) > 0)) {
      actions.push({
        key: 'estimate',
        workOrderId: wo.id,
        title: 'Set a cost estimate',
        detail: `${ref} has no envelope yet. Then add spend bit by bit.`,
      });
    }
    if (env.shopFloorOpen) {
      actions.push({
        key: 'return',
        workOrderId: wo.id,
        title: 'Return the machine to the line when it can run',
        detail: 'Shop-floor clock. Costs can stay open after that.',
      });
    }
    if (env.costOpen) {
      actions.push({
        key: 'spend',
        workOrderId: wo.id,
        title: env.machineBackOnLine ? 'Close finances when the last cost is posted' : 'Add spend (parts, feeding, lodging, labour)',
        detail: `${ref} — each kind of spend is its own payment request.`,
      });
    }
  }
  if (!open.length && String(machine?.status || '') === 'under_maintenance') {
    actions.push({
      key: 'status',
      workOrderId: '',
      title: 'Machine still marked under repair',
      detail: 'No open job on file. Edit the plant register back to Running if it is back on the line.',
    });
  }
  return actions.slice(0, 8);
}

/**
 * One machine file: registry fields, lifetime spend, every work order with envelope and cost lines.
 */
export function getMachineDossier(db, machineId, scope = {}) {
  const machine = getMachine(db, machineId);
  if (!machine) return { ok: false, error: 'Machine not found.' };
  const insightsRaw = buildMaintenanceMachineInsights(db, {
    viewAll: Boolean(scope.viewAll),
    branchId: scope.branchId || machine.branchId,
  });
  const insights = Array.isArray(insightsRaw) ? insightsRaw : insightsRaw?.machines || [];
  const events = listMaintenanceEventsForMachine(db, machine.id);
  const eventsByWo = new Map();
  for (const ev of events) {
    const list = eventsByWo.get(ev.workOrderId) || [];
    list.push(ev);
    eventsByWo.set(ev.workOrderId, list);
  }
  const workOrders = listWorkOrdersForMachine(db, machine.id).map((wo) => ({
    ...attachWorkOrderFinance(db, wo),
    events: eventsByWo.get(wo.id) || [],
  }));
  const costByKind = {};
  for (const wo of workOrders) {
    for (const [k, n] of Object.entries(wo.costByKind || {})) {
      costByKind[k] = (costByKind[k] || 0) + Number(n || 0);
    }
  }
  const fromInsights = insights.find((m) => m.machineId === machine.id) || {};
  const lifetimeNgn =
    Number(fromInsights.lifetimeMaintenanceNgn) ||
    Object.values(costByKind).reduce((s, n) => s + Number(n || 0), 0);
  const insight = {
    ...fromInsights,
    machineId: machine.id,
    name: fromInsights.name || machine.name,
    lifetimeMaintenanceNgn: lifetimeNgn,
    openWorkOrders:
      fromInsights.openWorkOrders ??
      workOrders.filter((w) => w.envelope?.shopFloorOpen || w.envelope?.costOpen).length,
    flag: fromInsights.flag || 'ok',
    flagLabel: fromInsights.flagLabel || fromInsights.flag || 'OK',
  };
  const currentFaults = workOrders.filter(workOrderStillActive);
  return {
    ok: true,
    machine,
    insight,
    workOrders,
    currentFaults,
    events: events.slice(0, 80),
    nextActions: buildMachineDossierNextActions(machine, workOrders),
    costByKind,
    linkableAssets: listMachineLinkableAssets(db, {
      viewAll: Boolean(scope.viewAll),
      branchId: scope.branchId || machine.branchId,
    }),
  };
}

export { listMachineLinkableAssets, listMachines };
