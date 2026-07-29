/**
 * Maintenance work-order mutations beyond create (assign, acknowledge, cost lines).
 */
import { appendAuditLog } from './controlOps.js';
import { nextMaintenanceCostLineHumanId } from './humanId.js';
import { DEFAULT_BRANCH_ID } from './branches.js';
import { appendMaintenanceEvent, listMaintenanceWorkOrders } from './workItems.js';
import { getMaintenanceVendor } from './maintenanceVendorsOps.js';

function nowIso() {
  return new Date().toISOString();
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
    machineName: row.machine_name || '',
    machineCode: row.machine_code || '',
    data,
  };
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

/**
 * Open corrective WOs for manager Issues inbox.
 * @param {import('better-sqlite3').Database} db
 * @param {{ branchId?: string, viewAll?: boolean }} scope
 */
export function listOpenMaintenanceIssues(db, scope = {}) {
  const branchId = String(scope.branchId || '').trim();
  const viewAll = Boolean(scope.viewAll);
  let sql = `
    SELECT wo.*, m.name AS machine_name, m.machine_code
    FROM maintenance_work_orders wo
    LEFT JOIN machines m ON m.id = wo.machine_id
    WHERE LOWER(COALESCE(wo.status, '')) NOT IN ('closed', 'cancelled', 'rejected')
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
  return db.prepare(sql).all(...params).map((row) => mapWo(row));
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
         WHEN LOWER(COALESCE(status, '')) IN ('closed', 'cancelled', 'rejected') THEN status
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
  const note = String(body?.note || body?.resolution || '').trim();
  if (!note) return { ok: false, error: 'Closing note is required.' };
  const atIso = nowIso();
  db.prepare(
    `UPDATE maintenance_work_orders
     SET resolution = ?, closed_at_iso = ?, closed_by_user_id = ?, status = 'closed'
     WHERE id = ?`
  ).run(note, atIso, String(actor?.id || '').trim() || null, wo.id);
  const ev = appendMaintenanceEvent(db, wo.id, { eventKind: 'closed', note, atIso }, actor);
  if (!ev.ok) return ev;
  return { ok: true, workOrder: getMaintenanceWorkOrder(db, wo.id), eventId: ev.eventId };
}

export function linkWorkOrderPaymentRequest(db, workOrderId, paymentRequestId, actor) {
  const wo = getMaintenanceWorkOrder(db, workOrderId);
  if (!wo) return { ok: false, error: 'Work order not found.' };
  const prid = String(paymentRequestId || '').trim();
  if (!prid) return { ok: false, error: 'paymentRequestId is required.' };
  const pr = db
    .prepare(
      `SELECT request_id, approval_status, amount_requested_ngn, paid_amount_ngn, expense_id
       FROM payment_requests WHERE request_id = ?`
    )
    .get(prid);
  if (!pr) return { ok: false, error: 'Payment request not found.' };
  db.prepare(`UPDATE maintenance_work_orders SET related_payment_request_id = ? WHERE id = ?`).run(prid, wo.id);
  appendMaintenanceEvent(
    db,
    wo.id,
    {
      eventKind: 'expense_linked',
      note: `Linked payment request ${prid}.`,
      data: { paymentRequestId: prid },
    },
    actor
  );

  // Attribute committed spend to the machine (Spend category totals still use PR/expense only).
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
          costKind: 'vendor',
          amountNgn,
          expenseCategory: 'Maintenance',
          sourceKind: 'payment_request',
          sourceId: prid,
          note: `Linked from ${prid}`,
        },
        actor
      );
      if (created.ok) costLineId = created.costLineId;
    }
  }

  return { ok: true, workOrder: getMaintenanceWorkOrder(db, wo.id), costLineId };
}

/**
 * Cost line hard-gated: must reference a real payment request or expense.
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
  const requestedVendorId = String(body?.vendorId || '').trim();
  if (!wo.vendorId && !requestedVendorId) {
    return { ok: false, error: 'Vendor is required before linking a payment request or expense cost line.' };
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
  if (sourceKind === 'payment_request') {
    const pr = db.prepare(`SELECT request_id FROM payment_requests WHERE request_id = ?`).get(sourceId);
    if (!pr) return { ok: false, error: 'Payment request not found for source_id.' };
  } else {
    const ex = db.prepare(`SELECT expense_id FROM expenses WHERE expense_id = ?`).get(sourceId);
    if (!ex) return { ok: false, error: 'Expense not found for source_id.' };
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
    String(body?.costKind || 'vendor').trim() || 'vendor',
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
  appendAuditLog(db, {
    actor,
    action: 'maintenance_cost_line.create',
    entityKind: 'maintenance_work_order',
    entityId: wo.id,
    note: `${amountNgn} via ${sourceKind} ${sourceId}`,
    details: { costLineId: id, sourceKind, sourceId },
  });
  return { ok: true, costLineId: id };
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
      costKind: r.cost_kind,
      amountNgn: Number(r.amount_ngn) || 0,
      expenseCategory: r.expense_category || '',
      note: r.note || '',
      postedAtIso: r.posted_at_iso,
      sourceKind: r.source_kind || '',
      sourceId: r.source_id || '',
    }));
}

/** Re-export list for convenience. */
export { listMaintenanceWorkOrders };
