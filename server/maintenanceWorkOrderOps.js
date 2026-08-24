/**
 * Maintenance work-order mutations beyond create (assign, acknowledge, cost lines, envelope).
 * Money side effect: cost lines only from a real payment request or expense.
 */
import { appendAuditLog } from './controlOps.js';
import { nextMaintenanceCostLineHumanId } from './humanId.js';
import { DEFAULT_BRANCH_ID } from './branches.js';
import { appendMaintenanceEvent, listMaintenanceWorkOrders } from './workItems.js';
import { getMaintenanceVendor } from './maintenanceVendorsOps.js';
import { hasColumn } from './ap2ReceivedBasisOps.js';
import {
  buildMaintenanceEnvelope,
  maintenanceCostKindRequiresVendor,
  maintenanceDowntimeHours,
  normalizeMaintenanceCostKind,
  normalizeMaintenanceWorkOrderKind,
  sumCostLinesByKind,
} from '../shared/lib/maintenanceCostEnvelope.js';
import { stampPlanServiceFromWorkOrder } from './operations/maintenancePlanOps.js';

function nowIso() {
  return new Date().toISOString();
}

function stampDowntimeHours(wo, atIso) {
  return maintenanceDowntimeHours({
    downtimeHours: wo.downtimeHours,
    openedAtIso: wo.openedAtIso,
    incidentDateIso: wo.incidentDateIso,
    returnedToProductionAtIso: wo.returnedToProductionAtIso || atIso,
    closedAtIso: wo.closedAtIso,
    nowMs: Date.parse(atIso) || Date.now(),
  });
}

function mapWo(row) {
  if (!row) return null;
  let data = {};
  try {
    data = row.data_json ? JSON.parse(row.data_json) : {};
  } catch {
    data = {};
  }
  return {
    id: row.id,
    referenceNo: row.reference_no,
    branchId: row.branch_id,
    machineId: row.machine_id,
    planId: row.plan_id || '',
    status: row.status,
    priority: row.priority,
    kind: row.kind,
    summary: row.summary,
    symptom: row.symptom || '',
    diagnosis: row.diagnosis || '',
    resolution: row.resolution || '',
    incidentDateIso: row.incident_date_iso || '',
    openedAtIso: row.opened_at_iso,
    acknowledgedAtIso: row.acknowledged_at_iso || '',
    closedAtIso: row.closed_at_iso || '',
    openedByUserId: row.opened_by_user_id || '',
    acknowledgedByUserId: row.acknowledged_by_user_id || '',
    assignedToUserId: row.assigned_to_user_id || '',
    downtimeHours: Number(row.downtime_hours) || 0,
    vendorId: row.vendor_id || '',
    vendorName: row.vendor_name || '',
    relatedPaymentRequestId: row.related_payment_request_id || '',
    relatedMaterialRequestId: row.related_material_request_id || '',
    relatedWorkItemId: row.related_work_item_id || '',
    estimatedCostNgn: Math.max(0, Math.round(Number(row.estimated_cost_ngn) || 0)),
    returnedToProductionAtIso: row.returned_to_production_at_iso || '',
    costClosedAtIso: row.cost_closed_at_iso || '',
    spentNgn:
      row.spent_ngn != null && row.spent_ngn !== ''
        ? Math.max(0, Math.round(Number(row.spent_ngn) || 0))
        : undefined,
    machineName: row.machine_name || '',
    machineCode: row.machine_code || '',
    data,
  };
}

function setMachineStatus(db, machineId, status, actor) {
  const mid = String(machineId || '').trim();
  if (!mid) return;
  try {
    db.prepare(
      `UPDATE machines SET status = ?, updated_at_iso = ?, updated_by_user_id = ? WHERE id = ?`
    ).run(status, nowIso(), String(actor?.id || '').trim() || null, mid);
  } catch {
    /* machine row optional in unit tests */
  }
}

function stampPaymentRequest(db, workOrderId, paymentRequestId, costKind) {
  if (!hasColumn(db, 'payment_requests', 'maintenance_work_order_id')) return;
  try {
    db.prepare(
      `UPDATE payment_requests
       SET maintenance_work_order_id = ?, maintenance_cost_kind = ?
       WHERE request_id = ?`
    ).run(workOrderId, normalizeMaintenanceCostKind(costKind), paymentRequestId);
  } catch {
    /* column may be absent in mocked DBs */
  }
}

export function getMaintenanceWorkOrder(db, workOrderId) {
  const id = String(workOrderId || '').trim();
  if (!id) return null;
  const row = db
    .prepare(
      `SELECT wo.*, m.name AS machine_name, m.machine_code
       FROM maintenance_work_orders wo
       LEFT JOIN machines m ON m.id = wo.machine_id
       WHERE wo.id = ?`
    )
    .get(id);
  return mapWo(row);
}

export function listWorkOrdersForMachine(db, machineId) {
  const mid = String(machineId || '').trim();
  if (!mid) return [];
  return db
    .prepare(
      `SELECT wo.*, m.name AS machine_name, m.machine_code
       FROM maintenance_work_orders wo
       LEFT JOIN machines m ON m.id = wo.machine_id
       WHERE wo.machine_id = ?
       ORDER BY wo.opened_at_iso DESC`
    )
    .all(mid)
    .map((row) => mapWo(row));
}

function mapEvent(row) {
  let data = {};
  try {
    data = row.data_json ? JSON.parse(row.data_json) : {};
  } catch {
    data = {};
  }
  return {
    id: row.id,
    workOrderId: row.work_order_id,
    workOrderRef: row.reference_no || row.work_order_id || '',
    eventKind: row.event_kind,
    note: row.note || '',
    atIso: row.at_iso,
    actorUserId: row.actor_user_id || '',
    actorDisplayName: row.actor_display_name || '',
    actorOfficeKey: row.actor_office_key || '',
    data,
  };
}

/**
 * Timeline for one machine (all work orders), newest first.
 * @param {import('better-sqlite3').Database} db
 * @param {string} machineId
 */
export function listMaintenanceEventsForMachine(db, machineId) {
  const mid = String(machineId || '').trim();
  if (!mid) return [];
  try {
    return db
      .prepare(
        `SELECT e.*, wo.reference_no
         FROM maintenance_events e
         INNER JOIN maintenance_work_orders wo ON wo.id = e.work_order_id
         WHERE wo.machine_id = ?
         ORDER BY e.at_iso DESC, e.id DESC`
      )
      .all(mid)
      .map((row) => mapEvent(row));
  } catch {
    return [];
  }
}

/**
 * Open corrective WOs for manager Issues inbox (includes cost-open jobs still accruing spend).
 * @param {import('better-sqlite3').Database} db
 * @param {{ branchId?: string, viewAll?: boolean }} scope
 */
export function listOpenMaintenanceIssues(db, scope = {}) {
  const branchId = String(scope.branchId || '').trim();
  const viewAll = Boolean(scope.viewAll);
  let sql = `
    SELECT wo.*, m.name AS machine_name, m.machine_code,
      COALESCE((
        SELECT SUM(cl.amount_ngn) FROM maintenance_cost_lines cl WHERE cl.work_order_id = wo.id
      ), 0) AS spent_ngn
    FROM maintenance_work_orders wo
    LEFT JOIN machines m ON m.id = wo.machine_id
    WHERE LOWER(COALESCE(wo.status, '')) NOT IN ('cancelled', 'rejected')
      AND NOT (
        LOWER(COALESCE(wo.status, '')) = 'closed'
        AND wo.cost_closed_at_iso IS NOT NULL
      )
  `;
  const params = [];
  if (!viewAll && branchId) {
    sql += ` AND wo.branch_id = ?`;
    params.push(branchId);
  }
  sql += ` ORDER BY
    CASE LOWER(wo.priority)
      WHEN 'machine_down' THEN 0
      WHEN 'high' THEN 1
      WHEN 'urgent' THEN 1
      ELSE 2
    END,
    wo.opened_at_iso DESC`;
  return db.prepare(sql).all(...params).map((row) => {
    const wo = mapWo(row);
    return {
      ...wo,
      envelope: buildMaintenanceEnvelope({
        estimatedCostNgn: wo.estimatedCostNgn,
        spentNgn: wo.spentNgn || 0,
        returnedToProductionAtIso: wo.returnedToProductionAtIso,
        costClosedAtIso: wo.costClosedAtIso,
        status: wo.status,
      }),
    };
  });
}

export function listMaintenanceCostLines(db, workOrderId) {
  const wid = String(workOrderId || '').trim();
  if (!wid) return [];
  return db
    .prepare(
      `SELECT * FROM maintenance_cost_lines WHERE work_order_id = ? ORDER BY posted_at_iso DESC`
    )
    .all(wid)
    .map((r) => ({
      id: r.id,
      workOrderId: r.work_order_id,
      costKind: normalizeMaintenanceCostKind(r.cost_kind),
      amountNgn: Number(r.amount_ngn) || 0,
      expenseCategory: r.expense_category || '',
      note: r.note || '',
      postedAtIso: r.posted_at_iso,
      sourceKind: r.source_kind || '',
      sourceId: r.source_id || '',
    }));
}

function mapPaymentRequestTag(row, costKindFallback = '') {
  return {
    requestID: row.request_id,
    amountRequestedNgn: Math.round(Number(row.amount_requested_ngn) || 0),
    paidAmountNgn: Math.round(Number(row.paid_amount_ngn) || 0),
    approvalStatus: row.approval_status || '',
    description: row.description || '',
    requestReference: row.request_reference || '',
    maintenanceWorkOrderId: row.maintenance_work_order_id || '',
    maintenanceCostKind: normalizeMaintenanceCostKind(
      row.maintenance_cost_kind || costKindFallback || 'other'
    ),
  };
}

export function listWorkOrderPaymentRequests(db, workOrderId) {
  const wid = String(workOrderId || '').trim();
  if (!wid) return [];
  const byId = new Map();
  if (hasColumn(db, 'payment_requests', 'maintenance_work_order_id')) {
    try {
      const stamped = db
        .prepare(
          `SELECT request_id, amount_requested_ngn, paid_amount_ngn, approval_status, description,
                  request_reference, maintenance_work_order_id, maintenance_cost_kind
           FROM payment_requests WHERE maintenance_work_order_id = ?`
        )
        .all(wid);
      for (const row of stamped) byId.set(row.request_id, mapPaymentRequestTag(row));
    } catch {
      /* mocked DBs */
    }
  }
  const lines = listMaintenanceCostLines(db, wid).filter((l) => l.sourceKind === 'payment_request' && l.sourceId);
  for (const line of lines) {
    if (byId.has(line.sourceId)) {
      const cur = byId.get(line.sourceId);
      byId.set(line.sourceId, { ...cur, maintenanceCostKind: line.costKind });
      continue;
    }
    try {
      const row = db
        .prepare(
          `SELECT request_id, amount_requested_ngn, paid_amount_ngn, approval_status, description,
                  request_reference, maintenance_work_order_id, maintenance_cost_kind
           FROM payment_requests WHERE request_id = ?`
        )
        .get(line.sourceId);
      if (row) byId.set(row.request_id, mapPaymentRequestTag(row, line.costKind));
    } catch {
      byId.set(line.sourceId, {
        requestID: line.sourceId,
        amountRequestedNgn: line.amountNgn,
        paidAmountNgn: 0,
        approvalStatus: '',
        description: line.note,
        requestReference: wid,
        maintenanceWorkOrderId: wid,
        maintenanceCostKind: line.costKind,
      });
    }
  }
  return [...byId.values()];
}

/**
 * Spent + envelope for a work order. Spent is attributed cost lines (committed PR/expense).
 */
export function attachWorkOrderFinance(db, wo) {
  if (!wo) return null;
  const costLines = listMaintenanceCostLines(db, wo.id);
  const spentNgn = costLines.reduce((s, l) => s + (Number(l.amountNgn) || 0), 0);
  const envelope = buildMaintenanceEnvelope({
    estimatedCostNgn: wo.estimatedCostNgn,
    spentNgn,
    returnedToProductionAtIso: wo.returnedToProductionAtIso,
    costClosedAtIso: wo.costClosedAtIso,
    status: wo.status,
  });
  return {
    ...wo,
    envelope,
    costLines,
    costByKind: sumCostLinesByKind(costLines),
    paymentRequests: listWorkOrderPaymentRequests(db, wo.id),
  };
}

export function acknowledgeMaintenanceWorkOrder(db, workOrderId, body, actor) {
  const wo = getMaintenanceWorkOrder(db, workOrderId);
  if (!wo) return { ok: false, error: 'Work order not found.' };
  const atIso = nowIso();
  const note = String(body?.note || 'Acknowledged by branch manager.').trim();
  db.prepare(
    `UPDATE maintenance_work_orders
     SET status = CASE WHEN LOWER(status) = 'open' THEN 'acknowledged' ELSE status END,
         acknowledged_at_iso = COALESCE(acknowledged_at_iso, ?),
         acknowledged_by_user_id = COALESCE(acknowledged_by_user_id, ?)
     WHERE id = ?`
  ).run(atIso, String(actor?.id || '').trim() || null, wo.id);
  const ev = appendMaintenanceEvent(db, wo.id, { eventKind: 'acknowledged', note, atIso }, actor);
  if (!ev.ok) return ev;
  return { ok: true, workOrder: getMaintenanceWorkOrder(db, wo.id), eventId: ev.eventId };
}

/**
 * Assign technician and/or vendor.
 */
export function assignMaintenanceWorkOrder(db, workOrderId, body, actor) {
  const wo = getMaintenanceWorkOrder(db, workOrderId);
  if (!wo) return { ok: false, error: 'Work order not found.' };
  const techId =
    body?.assignedToUserId != null ? String(body.assignedToUserId || '').trim() || null : undefined;
  const vendorId =
    body?.vendorId != null ? String(body.vendorId || '').trim() || null : undefined;
  let vendorName = wo.vendorName || null;
  if (vendorId !== undefined) {
    if (vendorId) {
      const v = getMaintenanceVendor(db, vendorId);
      if (!v || v.status !== 'active') return { ok: false, error: 'Active vendor required.' };
      vendorName = v.name;
    } else {
      vendorName = null;
    }
  }
  if (techId !== undefined) {
    db.prepare(`UPDATE maintenance_work_orders SET assigned_to_user_id = ? WHERE id = ?`).run(techId, wo.id);
  }
  if (vendorId !== undefined) {
    db.prepare(`UPDATE maintenance_work_orders SET vendor_id = ?, vendor_name = ? WHERE id = ?`).run(
      vendorId,
      vendorName,
      wo.id
    );
  }
  const assignedSomeone = Boolean(techId || vendorId);
  if (assignedSomeone) {
    db.prepare(
      `UPDATE maintenance_work_orders
       SET status = CASE
         WHEN LOWER(COALESCE(status, '')) IN ('closed', 'cancelled', 'rejected', 'returned_to_production') THEN status
         ELSE 'assigned'
       END
       WHERE id = ?`
    ).run(wo.id);
  }
  const parts = [];
  if (techId) parts.push(`technician ${techId}`);
  if (vendorId) parts.push(`vendor ${vendorName || vendorId}`);
  const note =
    String(body?.note || '').trim() ||
    (parts.length ? `Assigned ${parts.join(' / ')}.` : 'Assignment updated.');
  const ev = appendMaintenanceEvent(
    db,
    wo.id,
    { eventKind: 'assigned', note, data: { assignedToUserId: techId, vendorId } },
    actor
  );
  if (!ev.ok) return ev;
  return { ok: true, workOrder: getMaintenanceWorkOrder(db, wo.id), eventId: ev.eventId };
}

export function resolveMaintenanceWorkOrder(db, workOrderId, body, actor) {
  const wo = getMaintenanceWorkOrder(db, workOrderId);
  if (!wo) return { ok: false, error: 'Work order not found.' };
  const plantOpen = !wo.returnedToProductionAtIso;
  const moneyOpen = !wo.costClosedAtIso;
  if (plantOpen && moneyOpen) {
    return returnWorkOrderToProduction(db, workOrderId, body, actor);
  }
  if (moneyOpen) {
    return closeWorkOrderCosts(db, workOrderId, body, actor);
  }
  if (plantOpen) {
    return returnWorkOrderToProduction(db, workOrderId, body, actor);
  }
  return { ok: false, error: 'Work order already returned to production and finances are closed.' };
}

/** Shop floor clock: machine is running; money clock stays open unless already closed. */
export function returnWorkOrderToProduction(db, workOrderId, body, actor) {
  const wo = getMaintenanceWorkOrder(db, workOrderId);
  if (!wo) return { ok: false, error: 'Work order not found.' };
  const status = String(wo.status || '').toLowerCase();
  if (status === 'cancelled' || status === 'rejected') {
    return { ok: false, error: 'Cancelled work orders cannot return to production.' };
  }
  const atIso = nowIso();
  const hours = stampDowntimeHours(wo, atIso);
  const costsAlreadyClosed = Boolean(wo.costClosedAtIso);
  const actorId = String(actor?.id || '').trim() || null;
  const note = String(
    body?.note ||
      (costsAlreadyClosed
        ? 'Machine returned to production. Finances already closed.'
        : 'Machine returned to production. Cost envelope still open.')
  ).trim();
  db.prepare(
    `UPDATE maintenance_work_orders
     SET returned_to_production_at_iso = COALESCE(returned_to_production_at_iso, ?),
         downtime_hours = CASE WHEN COALESCE(downtime_hours, 0) > 0 THEN downtime_hours ELSE ? END,
         closed_at_iso = CASE WHEN ? = 1 THEN COALESCE(closed_at_iso, ?) ELSE closed_at_iso END,
         closed_by_user_id = CASE WHEN ? = 1 THEN COALESCE(closed_by_user_id, ?) ELSE closed_by_user_id END,
         status = CASE
           WHEN LOWER(COALESCE(status, '')) IN ('closed', 'cancelled', 'rejected') THEN status
           WHEN ? = 1 THEN 'closed'
           ELSE 'returned_to_production'
         END
     WHERE id = ?`
  ).run(
    atIso,
    hours,
    costsAlreadyClosed ? 1 : 0,
    atIso,
    costsAlreadyClosed ? 1 : 0,
    actorId,
    costsAlreadyClosed ? 1 : 0,
    wo.id
  );
  setMachineStatus(db, wo.machineId, 'active', actor);
  const ev = appendMaintenanceEvent(
    db,
    wo.id,
    { eventKind: 'returned_to_production', note, atIso },
    actor
  );
  if (!ev.ok) return ev;
  if (wo.planId && String(wo.kind || '').toLowerCase() === 'preventive') {
    try {
      stampPlanServiceFromWorkOrder(db, wo.planId, atIso, actor);
    } catch {
      /* plan stamp best-effort — shop floor already returned */
    }
  }
  return { ok: true, workOrder: getMaintenanceWorkOrder(db, wo.id), eventId: ev.eventId };
}

/** Money clock: last cost posted. Does not put the machine back on the line. */
export function closeWorkOrderCosts(db, workOrderId, body, actor) {
  const wo = getMaintenanceWorkOrder(db, workOrderId);
  if (!wo) return { ok: false, error: 'Work order not found.' };
  const atIso = nowIso();
  const hours = stampDowntimeHours(wo, atIso);
  const note = String(body?.note || 'Maintenance cost envelope closed.').trim();
  const plantBack = Boolean(wo.returnedToProductionAtIso);
  const actorId = String(actor?.id || '').trim() || null;
  db.prepare(
    `UPDATE maintenance_work_orders
     SET cost_closed_at_iso = COALESCE(cost_closed_at_iso, ?),
         closed_at_iso = CASE WHEN ? = 1 THEN COALESCE(closed_at_iso, ?) ELSE closed_at_iso END,
         closed_by_user_id = CASE WHEN ? = 1 THEN COALESCE(closed_by_user_id, ?) ELSE closed_by_user_id END,
         downtime_hours = CASE WHEN COALESCE(downtime_hours, 0) > 0 THEN downtime_hours ELSE ? END,
         status = CASE
           WHEN LOWER(COALESCE(status, '')) IN ('cancelled', 'rejected') THEN status
           WHEN ? = 1 THEN 'closed'
           ELSE status
         END
     WHERE id = ?`
  ).run(
    atIso,
    plantBack ? 1 : 0,
    atIso,
    plantBack ? 1 : 0,
    actorId,
    hours,
    plantBack ? 1 : 0,
    wo.id
  );
  if (plantBack) {
    setMachineStatus(db, wo.machineId, 'active', actor);
  }
  const ev = appendMaintenanceEvent(db, wo.id, { eventKind: 'costs_closed', note, atIso }, actor);
  if (!ev.ok) return ev;
  return { ok: true, workOrder: getMaintenanceWorkOrder(db, wo.id), eventId: ev.eventId };
}

export function patchWorkOrderEnvelope(db, workOrderId, body, actor) {
  const wo = getMaintenanceWorkOrder(db, workOrderId);
  if (!wo) return { ok: false, error: 'Work order not found.' };
  const estimated =
    body?.estimatedCostNgn != null
      ? Math.max(0, Math.round(Number(body.estimatedCostNgn) || 0))
      : wo.estimatedCostNgn;
  const kind =
    body?.kind != null ? normalizeMaintenanceWorkOrderKind(body.kind) : wo.kind || 'corrective';
  db.prepare(`UPDATE maintenance_work_orders SET estimated_cost_ngn = ?, kind = ? WHERE id = ?`).run(
    estimated,
    kind,
    wo.id
  );
  const note =
    String(body?.note || '').trim() ||
    `Envelope ${estimated} · kind ${kind}.`;
  appendMaintenanceEvent(db, wo.id, { eventKind: 'envelope_updated', note, data: { estimated, kind } }, actor);
  appendAuditLog(db, {
    actor,
    action: 'maintenance_work_order.envelope',
    entityKind: 'maintenance_work_order',
    entityId: wo.id,
    note,
    details: { estimatedCostNgn: estimated, kind },
  });
  return { ok: true, workOrder: getMaintenanceWorkOrder(db, wo.id) };
}

export function linkWorkOrderPaymentRequest(db, workOrderId, paymentRequestId, actor, opts = {}) {
  const wo = getMaintenanceWorkOrder(db, workOrderId);
  if (!wo) return { ok: false, error: 'Work order not found.' };
  const prid = String(paymentRequestId || '').trim();
  if (!prid) return { ok: false, error: 'paymentRequestId is required.' };
  const costKind = normalizeMaintenanceCostKind(opts.costKind || opts.cost_kind || 'other');
  const pr = db
    .prepare(
      `SELECT request_id, approval_status, amount_requested_ngn, paid_amount_ngn, expense_id
       FROM payment_requests WHERE request_id = ?`
    )
    .get(prid);
  if (!pr) return { ok: false, error: 'Payment request not found.' };
  if (!wo.relatedPaymentRequestId) {
    db.prepare(`UPDATE maintenance_work_orders SET related_payment_request_id = ? WHERE id = ?`).run(prid, wo.id);
  }
  stampPaymentRequest(db, wo.id, prid, costKind);
  appendMaintenanceEvent(
    db,
    wo.id,
    {
      eventKind: 'expense_linked',
      note: `Linked payment request ${prid} (${costKind}).`,
      data: { paymentRequestId: prid, costKind },
    },
    actor
  );

  const existingLine = db
    .prepare(
      `SELECT id FROM maintenance_cost_lines
       WHERE work_order_id = ? AND source_kind = 'payment_request' AND source_id = ?`
    )
    .get(wo.id, prid);
  let costLineId = existingLine?.id || null;
  if (!existingLine) {
    const amountNgn = Math.max(
      Math.round(Number(pr.paid_amount_ngn) || 0),
      Math.round(Number(pr.amount_requested_ngn) || 0)
    );
    if (amountNgn > 0) {
      const created = createMaintenanceCostLine(
        db,
        wo.id,
        {
          costKind,
          amountNgn,
          expenseCategory: 'Maintenance',
          sourceKind: 'payment_request',
          sourceId: prid,
          note: `Linked from ${prid}`,
        },
        actor
      );
      if (created.ok) costLineId = created.costLineId;
      else return { ...created, workOrder: getMaintenanceWorkOrder(db, wo.id) };
    }
  }

  return { ok: true, workOrder: getMaintenanceWorkOrder(db, wo.id), costLineId };
}

/**
 * Cost line hard-gated: must reference a real payment request or expense.
 * Vendor is required only for contractor cost kinds.
 */
export function createMaintenanceCostLine(db, workOrderId, body, actor) {
  const wo = getMaintenanceWorkOrder(db, workOrderId);
  if (!wo) return { ok: false, error: 'Work order not found.' };
  const sourceKind = String(body?.sourceKind || '').trim().toLowerCase();
  const sourceId = String(body?.sourceId || '').trim();
  if (!sourceKind || !sourceId) {
    return { ok: false, error: 'Cost lines require sourceKind and sourceId (payment_request or expense).' };
  }
  if (sourceKind !== 'payment_request' && sourceKind !== 'expense') {
    return { ok: false, error: 'sourceKind must be payment_request or expense.' };
  }
  const costKind = normalizeMaintenanceCostKind(body?.costKind || 'other');
  if (sourceKind === 'payment_request') {
    const pr = db.prepare(`SELECT request_id FROM payment_requests WHERE request_id = ?`).get(sourceId);
    if (!pr) return { ok: false, error: 'Payment request not found for source_id.' };
  } else {
    const ex = db.prepare(`SELECT expense_id FROM expenses WHERE expense_id = ?`).get(sourceId);
    if (!ex) return { ok: false, error: 'Expense not found for source_id.' };
  }
  const requestedVendorId = String(body?.vendorId || '').trim();
  if (maintenanceCostKindRequiresVendor(costKind) && !wo.vendorId && !requestedVendorId) {
    return { ok: false, error: 'Vendor is required before linking a contractor cost line.' };
  }
  if (!wo.vendorId && requestedVendorId) {
    const vendor = getMaintenanceVendor(db, requestedVendorId);
    if (!vendor || vendor.status !== 'active') return { ok: false, error: 'Active vendor required.' };
    db.prepare(`UPDATE maintenance_work_orders SET vendor_id = ?, vendor_name = ? WHERE id = ?`).run(
      vendor.id,
      vendor.name,
      wo.id
    );
  }
  const amountNgn = Math.round(Number(body?.amountNgn) || 0);
  if (amountNgn <= 0) return { ok: false, error: 'amountNgn must be positive.' };
  const id = nextMaintenanceCostLineHumanId(db, wo.branchId || DEFAULT_BRANCH_ID);
  const postedAt = String(body?.postedAtIso || '').trim() || nowIso();
  db.prepare(
    `INSERT INTO maintenance_cost_lines (
      id, work_order_id, cost_kind, amount_ngn, expense_category, note, posted_at_iso,
      created_by_user_id, source_kind, source_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    wo.id,
    costKind,
    amountNgn,
    String(body?.expenseCategory || 'Maintenance').trim() || 'Maintenance',
    String(body?.note || '').trim() || null,
    postedAt,
    String(actor?.id || '').trim() || null,
    sourceKind,
    sourceId
  );
  if (!wo.relatedPaymentRequestId && sourceKind === 'payment_request') {
    db.prepare(`UPDATE maintenance_work_orders SET related_payment_request_id = ? WHERE id = ?`).run(
      sourceId,
      wo.id
    );
  }
  if (sourceKind === 'payment_request') stampPaymentRequest(db, wo.id, sourceId, costKind);
  appendAuditLog(db, {
    actor,
    action: 'maintenance_cost_line.create',
    entityKind: 'maintenance_work_order',
    entityId: wo.id,
    note: `${amountNgn} ${costKind} via ${sourceKind} ${sourceId}`,
    details: { costLineId: id, sourceKind, sourceId, costKind },
  });
  return { ok: true, costLineId: id };
}

/** Re-export list for convenience. */
export { listMaintenanceWorkOrders };
