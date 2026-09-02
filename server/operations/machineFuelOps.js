/**
 * Diesel / fuel requests against a plant-register machine (generator, forklift).
 * Money side effect: creates a Fuel & lubricant payment request and a standing fuel log.
 */
import { insertPaymentRequest } from '../controlOps.js';
import { nextMachineFuelLogHumanId } from '../humanId.js';
import { hasColumn } from '../ap2ReceivedBasisOps.js';
import { isFuelConsumingMachineType } from '../../shared/maintenanceRegistry.js';
import { normalizeMaintenanceCostKind } from '../../shared/lib/maintenanceCostEnvelope.js';
import { entityBranchWriteAllowed } from '../workspaceBranchGuards.js';

const FUEL_KINDS = new Set(['diesel', 'petrol', 'other']);

function nowIso() {
  return new Date().toISOString();
}

function mapFuelLog(row) {
  if (!row) return null;
  return {
    id: row.id,
    machineId: row.machine_id,
    branchId: row.branch_id,
    machineName: row.machine_name || '',
    machineCode: row.machine_code || '',
    machineType: row.machine_type || '',
    fuelKind: row.fuel_kind || 'diesel',
    litres: Number(row.litres) || 0,
    amountNgn: Math.max(0, Math.round(Number(row.amount_ngn) || 0)),
    paymentRequestId: row.payment_request_id || '',
    payeeName: row.payee_name || '',
    note: row.note || '',
    postedAtIso: row.posted_at_iso,
    createdAtIso: row.created_at_iso,
  };
}

function stampPaymentRequestMachine(db, requestId, machineId, costKind) {
  const rid = String(requestId || '').trim();
  const mid = String(machineId || '').trim();
  if (!rid || !mid) return;
  const kind = normalizeMaintenanceCostKind(costKind || 'fuel');
  if (hasColumn(db, 'payment_requests', 'maintenance_machine_id')) {
    db.prepare(
      `UPDATE payment_requests
       SET maintenance_machine_id = ?, maintenance_cost_kind = COALESCE(NULLIF(maintenance_cost_kind, ''), ?)
       WHERE request_id = ?`
    ).run(mid, kind, rid);
    return;
  }
  if (hasColumn(db, 'payment_requests', 'maintenance_cost_kind')) {
    db.prepare(`UPDATE payment_requests SET maintenance_cost_kind = ? WHERE request_id = ?`).run(kind, rid);
  }
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} machineId
 * @returns {object[]}
 */
export function listMachineFuelLogs(db, machineId, opts = {}) {
  const mid = String(machineId || '').trim();
  if (!mid) return [];
  const limit = Math.min(80, Math.max(1, Math.round(Number(opts.limit) || 40)));
  try {
    return db
      .prepare(
        `SELECT f.*, m.name AS machine_name, m.machine_code, m.machine_type
         FROM machine_fuel_logs f
         LEFT JOIN machines m ON m.id = f.machine_id
         WHERE f.machine_id = ?
         ORDER BY f.posted_at_iso DESC
         LIMIT ?`
      )
      .all(mid, limit)
      .map(mapFuelLog);
  } catch {
    return [];
  }
}

/**
 * Store / ops diesel request: payment request + standing log on the machine file.
 * @param {import('better-sqlite3').Database} db
 * @param {object} body
 * @param {object} actor
 */
export function createMachineFuelRequest(db, body, actor, workspaceBranchId = '') {
  const machineId = String(body?.machineId || '').trim();
  if (!machineId) return { ok: false, error: 'Choose the generator or forklift.' };
  let machine;
  try {
    machine = db
      .prepare(`SELECT id, branch_id, name, machine_code, machine_type, status FROM machines WHERE id = ?`)
      .get(machineId);
  } catch {
    return { ok: false, error: 'Plant register is not available.' };
  }
  if (!machine) return { ok: false, error: 'Machine not found.' };
  if (!entityBranchWriteAllowed(actor, machine.branch_id, workspaceBranchId)) {
    return { ok: false, error: 'This machine is not in your current workspace branch.' };
  }
  if (String(machine.status || '').toLowerCase() === 'decommissioned') {
    return { ok: false, error: 'That machine is decommissioned.' };
  }
  if (!isFuelConsumingMachineType(machine.machine_type)) {
    return { ok: false, error: 'Diesel requests are only for the generator or forklift.' };
  }
  const litres = Math.max(0, Number(body?.litres) || 0);
  if (!(litres > 0)) return { ok: false, error: 'Enter litres requested.' };
  const amountNgn = Math.round(Number(body?.amountNgn ?? body?.amount_ngn) || 0);
  if (!(amountNgn > 0)) return { ok: false, error: 'Enter the estimated amount.' };
  const rawKind = String(body?.fuelKind || body?.fuel_kind || 'diesel')
    .trim()
    .toLowerCase();
  const fuelKind = FUEL_KINDS.has(rawKind) ? rawKind : 'diesel';
  const payeeName = String(body?.payeeName || body?.payee_name || '').trim();
  const note = String(body?.note || '').trim();
  const branchId = String(machine.branch_id || workspaceBranchId || '').trim();
  const label = machine.name || machine.machine_code || machineId;
  const fuelWord = fuelKind === 'petrol' ? 'Petrol' : 'Diesel';
  const item = `${fuelWord} ${litres} L — ${label}`;
  const pr = insertPaymentRequest(
    db,
    {
      workspaceBranchId: branchId,
      expenseCategory: 'Fuel & lubricant',
      description: note ? `${item}. ${note}` : item,
      payeeName,
      requestReference: `FUEL-${machine.machine_code || machine.id}`,
      requestDate: nowIso().slice(0, 10),
      lineItems: [
        {
          item,
          unit: 1,
          unitPriceNgn: amountNgn,
        },
      ],
    },
    actor
  );
  if (!pr?.ok) return { ok: false, error: pr?.error || 'Could not submit the diesel payment request.' };

  stampPaymentRequestMachine(db, pr.requestID, machine.id, 'fuel');

  const postedAtIso = nowIso();
  let logId = '';
  try {
    logId = nextMachineFuelLogHumanId(db, branchId);
    db.prepare(
      `INSERT INTO machine_fuel_logs (
        id, machine_id, branch_id, fuel_kind, litres, amount_ngn, payment_request_id, payee_name, note,
        posted_at_iso, created_at_iso, created_by_user_id
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      logId,
      machine.id,
      branchId,
      fuelKind,
      litres,
      amountNgn,
      pr.requestID || null,
      payeeName || null,
      note || null,
      postedAtIso,
      postedAtIso,
      String(actor?.id || '').trim() || null
    );
  } catch (e) {
    return {
      ok: true,
      requestID: pr.requestID,
      logId: '',
      warning: String(e?.message || e) || 'Payment request submitted but the fuel log could not be saved.',
    };
  }
  return { ok: true, requestID: pr.requestID, logId, machineId: machine.id };
}
