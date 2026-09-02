/**
 * Preventive service plans on the plant register.
 * Opening a job from a plan creates a preventive work order; completing a service
 * stamps last_service and advances next_due. Shop-floor return also stamps the plan.
 */
import { DEFAULT_BRANCH_ID } from '../branches.js';
import { appendAuditLog } from '../controlOps.js';
import { createMaintenanceWorkOrder } from '../workItems.js';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Reject a next-due date further out than this — a typo like 2099-01-01 would otherwise
 * silently disable the preventive-maintenance alert for that plan with no warning. */
const MAX_NEXT_DUE_HORIZON_DAYS = 1825; // 5 years

function nowIso() {
  return new Date().toISOString();
}

function addDaysIso(fromIso, days) {
  const base = Date.parse(String(fromIso || '').trim()) || Date.now();
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() + Math.max(1, Math.round(Number(days) || 0)));
  return d.toISOString().slice(0, 10);
}

function daysBetweenIso(fromIso, toIso) {
  const a = Date.parse(`${fromIso}T00:00:00.000Z`);
  const b = Date.parse(`${toIso}T00:00:00.000Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.round((b - a) / 86400000);
}

function mapPlan(row) {
  if (!row) return null;
  return {
    id: row.id,
    referenceNo: row.reference_no,
    branchId: row.branch_id,
    machineId: row.machine_id,
    machineName: row.machine_name || '',
    machineCode: row.machine_code || '',
    machineType: row.machine_type || '',
    status: row.status,
    planKind: row.plan_kind,
    summary: row.summary,
    calendarIntervalDays: row.calendar_interval_days,
    meterInterval: row.meter_interval,
    nextDueDateIso: row.next_due_date_iso || '',
    nextDueMeter: row.next_due_meter,
    lastServiceAtIso: row.last_service_at_iso || '',
    lastServiceMeter: row.last_service_meter,
    approvalRequired: Boolean(row.approval_required),
    responsibleOfficeKey: row.responsible_office_key,
    notes: row.notes || '',
  };
}

function getPlanRow(db, planId) {
  const id = String(planId || '').trim();
  if (!id) return null;
  return (
    db
      .prepare(
        `SELECT p.*, m.name AS machine_name, m.machine_code, m.machine_type
         FROM maintenance_plans p
         LEFT JOIN machines m ON m.id = p.machine_id
         WHERE p.id = ?`
      )
      .get(id) || null
  );
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} machineId
 */
export function listPlansForMachine(db, machineId) {
  const mid = String(machineId || '').trim();
  if (!mid) return [];
  try {
    return db
      .prepare(
        `SELECT p.*, m.name AS machine_name, m.machine_code, m.machine_type
         FROM maintenance_plans p
         LEFT JOIN machines m ON m.id = p.machine_id
         WHERE p.machine_id = ?
         ORDER BY p.next_due_date_iso ASC, p.updated_at_iso DESC`
      )
      .all(mid)
      .map(mapPlan);
  } catch {
    return [];
  }
}

/**
 * Stamp last service and roll next due. Used when BM marks service done or when
 * a preventive work order returns to production.
 */
export function stampPlanService(db, planId, body = {}, actor = null) {
  const row = getPlanRow(db, planId);
  if (!row) return { ok: false, error: 'Service plan not found.' };
  const lastServiceRaw = String(body?.lastServiceAtIso || '').trim();
  if (lastServiceRaw && !ISO_DATE_RE.test(lastServiceRaw.slice(0, 10))) {
    return { ok: false, error: 'Last service date must be a valid date (YYYY-MM-DD).' };
  }
  const atIso = lastServiceRaw || nowIso();
  const interval = Math.max(1, Math.round(Number(body?.calendarIntervalDays ?? row.calendar_interval_days) || 30));
  const nextDueRaw = String(body?.nextDueDateIso || '').trim();
  if (nextDueRaw && !ISO_DATE_RE.test(nextDueRaw.slice(0, 10))) {
    return { ok: false, error: 'Next due date must be a valid date (YYYY-MM-DD).' };
  }
  const nextDue = nextDueRaw || addDaysIso(atIso, interval);
  if (daysBetweenIso(atIso.slice(0, 10), nextDue.slice(0, 10)) > MAX_NEXT_DUE_HORIZON_DAYS) {
    return {
      ok: false,
      error: `Next due date is more than ${MAX_NEXT_DUE_HORIZON_DAYS} days out — check for a typo.`,
    };
  }
  const lastMeter =
    body?.lastServiceMeter != null ? Number(body.lastServiceMeter) || 0 : row.last_service_meter;
  const nextMeter =
    body?.nextDueMeter != null
      ? Number(body.nextDueMeter) || 0
      : row.meter_interval != null && lastMeter != null
        ? Number(lastMeter) + Number(row.meter_interval || 0)
        : row.next_due_meter;
  db.prepare(
    `UPDATE maintenance_plans
     SET last_service_at_iso = ?,
         last_service_meter = ?,
         next_due_date_iso = ?,
         next_due_meter = ?,
         updated_at_iso = ?,
         updated_by_user_id = ?
     WHERE id = ?`
  ).run(
    atIso.slice(0, 10),
    lastMeter != null ? lastMeter : null,
    nextDue.slice(0, 10),
    nextMeter != null ? nextMeter : null,
    nowIso(),
    String(actor?.id || '').trim() || null,
    row.id
  );
  appendAuditLog(db, {
    actor,
    action: 'maintenance_plan.service',
    entityKind: 'maintenance_plan',
    entityId: row.id,
    note: `Serviced ${row.machine_name || row.machine_id}; next due ${nextDue.slice(0, 10)}`,
  });
  return { ok: true, plan: mapPlan(getPlanRow(db, row.id)) };
}

/** Shop-floor clock closed on a preventive job — advance the linked plan. */
export function stampPlanServiceFromWorkOrder(db, planId, atIso, actor) {
  const id = String(planId || '').trim();
  if (!id) return { ok: true, skipped: true };
  return stampPlanService(db, id, { lastServiceAtIso: atIso }, actor);
}

function findOpenPlanWorkOrderId(db, planId) {
  const rows = db
    .prepare(
      `SELECT id, status, returned_to_production_at_iso
       FROM maintenance_work_orders
       WHERE plan_id = ?
       ORDER BY opened_at_iso DESC`
    )
    .all(planId);
  for (const row of rows) {
    const status = String(row.status || '').toLowerCase();
    if (status === 'cancelled' || status === 'rejected') continue;
    if (row.returned_to_production_at_iso) continue;
    return String(row.id || '').trim();
  }
  return '';
}

/**
 * Open (or reuse) a preventive work order from a due service plan.
 */
export function openWorkOrderFromPlan(db, planId, actor, workspaceBranchId = DEFAULT_BRANCH_ID) {
  const row = getPlanRow(db, planId);
  if (!row) return { ok: false, error: 'Service plan not found.' };
  if (String(row.status || '').toLowerCase() !== 'active') {
    return { ok: false, error: 'That service plan is not active.' };
  }
  const existing = findOpenPlanWorkOrderId(db, row.id);
  if (existing) return { ok: true, workOrderId: existing, reused: true };
  const label = row.machine_name || row.machine_code || row.machine_id;
  const due = String(row.next_due_date_iso || '').slice(0, 10);
  const summary = String(row.summary || '').trim() || `Service ${label}`;
  const created = createMaintenanceWorkOrder(
    db,
    {
      branchId: row.branch_id || workspaceBranchId,
      machineId: row.machine_id,
      planId: row.id,
      kind: 'preventive',
      priority: 'normal',
      summary: due ? `${summary} (due ${due})` : summary,
      symptom: due ? `Scheduled service due ${due}.` : 'Scheduled service.',
      status: 'open',
    },
    actor,
    row.branch_id || workspaceBranchId
  );
  if (!created?.ok) return { ok: false, error: created?.error || 'Could not open the service job.' };
  return { ok: true, workOrderId: created.workOrderId, reused: false };
}
