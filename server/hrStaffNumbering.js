/**
 * Phase 8 — staff employee number configuration, reservation, renumbering.
 * @module server/hrStaffNumbering
 */

import crypto from 'node:crypto';
import {
  createEmployeeNumberAllocator,
  expandReservedEmployeeNumbers,
  formatStaffEmployeeNumber,
  getDefaultStaffNumberConfig,
  isReservedEmployeeNumber,
  normalizeStaffNumberConfig,
  resolveEmployeeBranchCode,
} from '../shared/lib/hrEmployeeNumber.js';
import { appendHrAuditEvent, hrTablesReady } from './hrOps.js';
import { hrTableExists } from './hrTableChecks.js';

function nowIso() {
  return new Date().toISOString();
}

function newId(prefix) {
  return `${prefix}-${crypto.randomBytes(8).toString('hex')}`;
}

function safeJsonParse(raw, fallback) {
  try {
    const v = JSON.parse(String(raw || ''));
    return v && typeof v === 'object' ? v : fallback;
  } catch {
    return fallback;
  }
}

export { getDefaultStaffNumberConfig } from '../shared/lib/hrEmployeeNumber.js';

export function getStaffNumberConfig(db) {
  if (!hrTableExists(db, 'hr_settings')) return getDefaultStaffNumberConfig();
  const row = db.prepare(`SELECT value_json FROM hr_settings WHERE key = 'staff_number_config'`).get();
  if (!row?.value_json) return getDefaultStaffNumberConfig();
  return normalizeStaffNumberConfig({ ...getDefaultStaffNumberConfig(), ...safeJsonParse(row.value_json, {}) });
}

export function saveStaffNumberConfig(db, config, actor) {
  if (!hrTableExists(db, 'hr_settings')) return { ok: false, error: 'HR settings not initialised.' };
  const normalized = normalizeStaffNumberConfig(config);
  const now = nowIso();
  db.prepare(
    `INSERT INTO hr_settings (key, value_json, updated_at_iso, updated_by_user_id)
     VALUES ('staff_number_config', ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at_iso=excluded.updated_at_iso, updated_by_user_id=excluded.updated_by_user_id`
  ).run(JSON.stringify(normalized), now, actor?.id || null);
  appendHrAuditEvent(db, {
    actorUserId: actor?.id,
    action: 'hr.staff_id.config_updated',
    entityKind: 'hr_settings',
    entityId: 'staff_number_config',
  });
  return { ok: true, config: normalized };
}

export function previewStaffRenumbering(db, config) {
  if (!hrTablesReady(db)) return { ok: false, error: 'HR not initialised.' };
  const cfg = normalizeStaffNumberConfig(config);
  const reservedNums = expandReservedEmployeeNumbers(cfg);
  const staff = db
    .prepare(
      `SELECT p.user_id AS userId, p.branch_id AS branchId, u.display_name AS displayName,
              p.employee_no AS currentEmployeeNo, p.job_title AS jobTitle
       FROM hr_staff_profiles p JOIN app_users u ON u.id = p.user_id
       WHERE p.employment_status IS NULL OR lower(p.employment_status) NOT IN ('terminated','separated')
       ORDER BY u.display_name ASC`
    )
    .all();
  const allocator =
    cfg.format === 'branch_prefixed'
      ? createEmployeeNumberAllocator(db, cfg, { takenFormatted: new Set() })
      : null;
  let next = Math.max(cfg.startingNumber || 6, 6);
  const mappings = [];
  const conflicts = [];
  for (const s of staff) {
    const cur = String(s.currentEmployeeNo || '').trim();
    if (cur && (reservedNums.has(cur) || isReservedEmployeeNumber(cur, cfg))) {
      mappings.push({ ...s, newEmployeeNo: cur, reserved: true });
      continue;
    }
    let newNo;
    if (allocator) {
      newNo = allocator.next({ branchId: s.branchId });
    } else {
      while (
        reservedNums.has(String(next)) ||
        isReservedEmployeeNumber(formatStaffEmployeeNumber(cfg, next, { branchId: s.branchId, db }), cfg)
      ) {
        next += 1;
      }
      newNo = formatStaffEmployeeNumber(cfg, next, { branchId: s.branchId, db });
      next += 1;
    }
    if (staff.some((x) => x !== s && String(x.currentEmployeeNo) === newNo)) {
      conflicts.push({ userId: s.userId, displayName: s.displayName, newEmployeeNo: newNo });
    }
    mappings.push({ ...s, newEmployeeNo: newNo, reserved: false });
  }
  return { ok: true, mappings, conflicts, reserved: cfg.reserved || [] };
}

export function applyStaffRenumbering(db, actor, config, { confirmPhrase } = {}) {
  if (String(confirmPhrase || '').trim() !== 'RESET LIVE STAFF NUMBERS') {
    return { ok: false, error: 'Confirmation phrase required: RESET LIVE STAFF NUMBERS' };
  }
  const preview = previewStaffRenumbering(db, config);
  if (!preview.ok) return preview;
  if (preview.conflicts?.length) {
    return { ok: false, error: 'Conflicts detected. Resolve before applying.', conflicts: preview.conflicts };
  }
  const batchId = newId('HRNUM');
  const now = nowIso();
  for (const m of preview.mappings) {
    if (m.reserved && m.currentEmployeeNo === m.newEmployeeNo) continue;
    db.prepare(`UPDATE hr_staff_profiles SET employee_no = ? WHERE user_id = ?`).run(m.newEmployeeNo, m.userId);
    if (hrTableExists(db, 'hr_employee_number_history')) {
      db.prepare(
        `INSERT INTO hr_employee_number_history (id, user_id, old_employee_no, new_employee_no, batch_id, changed_at_iso, changed_by_user_id)
         VALUES (?,?,?,?,?,?,?)`
      ).run(newId('HRNUMH'), m.userId, m.currentEmployeeNo || null, m.newEmployeeNo, batchId, now, actor?.id || null);
    }
  }
  const saved = { ...normalizeStaffNumberConfig(config), lastAppliedAtIso: now, lastBatchId: batchId };
  saveStaffNumberConfig(db, saved, actor);
  appendHrAuditEvent(db, {
    actorUserId: actor?.id,
    action: 'hr.staff_id.reset',
    entityKind: 'hr_staff_number_batch',
    entityId: batchId,
    details: { count: preview.mappings.length },
  });
  return { ok: true, batchId, applied: preview.mappings.length, config: saved };
}

export function listEmployeeNumberHistory(db, userId) {
  if (!hrTableExists(db, 'hr_employee_number_history')) return [];
  return db
    .prepare(
      `SELECT old_employee_no AS oldEmployeeNo, new_employee_no AS newEmployeeNo, changed_at_iso AS changedAtIso, batch_id AS batchId
       FROM hr_employee_number_history WHERE user_id = ? ORDER BY changed_at_iso DESC`
    )
    .all(String(userId || '').trim());
}

export function listStaffWithoutEmployeeNo(db, scope) {
  if (!hrTablesReady(db)) return [];
  let sql = `SELECT p.user_id AS userId, u.display_name AS displayName, p.branch_id AS branchId
             FROM hr_staff_profiles p JOIN app_users u ON u.id = p.user_id
             WHERE employee_no IS NULL OR trim(employee_no) = ''`;
  const args = [];
  if (!scope?.viewAll) {
    sql += ` AND p.branch_id = ?`;
    args.push(scope?.branchId || 'BR-HQ');
  }
  return db.prepare(sql).all(...args);
}

export { resolveEmployeeBranchCode };
