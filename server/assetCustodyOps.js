/**
 * Asset custody and gate pass manual logging.
 * @module server/assetCustodyOps
 */

import crypto from 'node:crypto';
import { DEFAULT_BRANCH_ID } from './branches.js';
import { hrTableExists } from './hrTableChecks.js';

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}-${crypto.randomBytes(8).toString('hex')}`;
}

export function recordAssetCustodyEvent(db, actor, body = {}) {
  if (!hrTableExists(db, 'asset_custody_events')) {
    return { ok: false, error: 'Asset custody module not migrated.' };
  }
  const branchId = String(body.branchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
  const eventType = String(body.eventType || '').trim();
  const allowed = new Set(['assign', 'transfer', 'confirm_present', 'report_missing']);
  if (!allowed.has(eventType)) return { ok: false, error: 'Invalid event_type.' };
  const assetId = String(body.assetId || '').trim() || null;
  const machineId = String(body.machineId || '').trim() || null;
  if (!assetId && !machineId) return { ok: false, error: 'assetId or machineId is required.' };
  const id = newId('ACU');
  const now = nowIso();
  db.prepare(
    `INSERT INTO asset_custody_events (
      id, asset_id, machine_id, branch_id, location_label, custodian_user_id, event_type,
      shift_day_iso, daily_roll_id, note, created_at_iso, created_by_user_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    assetId,
    machineId,
    branchId,
    String(body.locationLabel || '').trim() || null,
    String(body.custodianUserId || '').trim() || null,
    eventType,
    String(body.shiftDayIso || '').slice(0, 10) || null,
    String(body.dailyRollId || '').trim() || null,
    String(body.note || '').trim() || null,
    now,
    actor?.id || null
  );
  return { ok: true, id };
}

export function listAssetCustodyTimeline(db, assetId, machineId) {
  if (!hrTableExists(db, 'asset_custody_events')) return [];
  const aid = String(assetId || '').trim();
  const mid = String(machineId || '').trim();
  if (aid) {
    return db
      .prepare(`SELECT * FROM asset_custody_events WHERE asset_id = ? ORDER BY created_at_iso DESC LIMIT 100`)
      .all(aid);
  }
  if (mid) {
    return db
      .prepare(`SELECT * FROM asset_custody_events WHERE machine_id = ? ORDER BY created_at_iso DESC LIMIT 100`)
      .all(mid);
  }
  return [];
}

export function recordGatePassEvent(db, actor, body = {}) {
  if (!hrTableExists(db, 'gate_pass_events')) {
    return { ok: false, error: 'Gate pass module not migrated.' };
  }
  const branchId = String(body.branchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
  const passDateIso = String(body.passDateIso || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(passDateIso)) {
    return { ok: false, error: 'Valid passDateIso (YYYY-MM-DD) is required.' };
  }
  const direction = String(body.direction || '').trim();
  if (!['in', 'out'].includes(direction)) return { ok: false, error: 'direction must be in or out.' };
  const id = newId('GPE');
  const now = nowIso();
  const assetIds = Array.isArray(body.assetIds) ? body.assetIds : [];
  db.prepare(
    `INSERT INTO gate_pass_events (
      id, branch_id, pass_date_iso, direction, authorized_by_user_id, vehicle_ref,
      personnel_summary, asset_ids_json, notes, created_at_iso, created_by_user_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    branchId,
    passDateIso,
    direction,
    String(body.authorizedByUserId || actor?.id || '').trim() || null,
    String(body.vehicleRef || '').trim() || null,
    String(body.personnelSummary || '').trim() || null,
    JSON.stringify(assetIds),
    String(body.notes || '').trim() || null,
    now,
    actor?.id || null
  );
  return { ok: true, id };
}

export function listGatePassEvents(db, branchId, passDateIso) {
  if (!hrTableExists(db, 'gate_pass_events')) return [];
  let sql = `SELECT * FROM gate_pass_events WHERE branch_id = ?`;
  const args = [String(branchId || DEFAULT_BRANCH_ID).trim()];
  if (passDateIso) {
    sql += ` AND pass_date_iso = ?`;
    args.push(String(passDateIso).slice(0, 10));
  }
  sql += ` ORDER BY created_at_iso DESC LIMIT 200`;
  return db.prepare(sql).all(...args);
}
