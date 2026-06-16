/**
 * HR Phase 2 policy workflows: absence, exit clearance, temp alerts, promotion due.
 * @module server/hrPhase2Ops
 */

import crypto from 'crypto';
import { buildSimpleTextPdf } from '../shared/lib/simpleTextPdf.js';
import { buildHrLetterContent } from './hrLetterTemplates.js';
import {
  appendHrAuditEvent,
  getStaffDisciplinaryQueryCount,
  hrTablesReady,
  listHrStaff,
  nowIso,
} from './hrOps.js';
import { patchHrStaffSeparation } from './hrStaffLifecycle.js';
import { assertStaffUserIdInHrScope } from './hrStaffScope.js';

function newId(prefix) {
  return `${prefix}-${crypto.randomBytes(10).toString('hex')}`;
}

function safeJsonParse(raw, fallback) {
  try {
    const v = JSON.parse(String(raw || ''));
    return v && typeof v === 'object' ? v : fallback;
  } catch {
    return fallback;
  }
}

function diffDays(fromIso, toIso) {
  const a = Date.parse(String(fromIso || '').slice(0, 10));
  const b = Date.parse(String(toIso || '').slice(0, 10));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return 0;
  return Math.max(0, Math.floor((b - a) / (24 * 60 * 60 * 1000)) + 1);
}

const ABSENCE_TYPES = new Set(['illness', 'family_emergency', 'bereavement', 'official', 'unauthorized', 'other']);
const ABSENCE_STATUSES = new Set(['reported', 'hr_review', 'approved', 'rejected', 'unauthorized', 'closed']);
const EXIT_SEPARATION_TYPES = new Set(['resignation', 'termination', 'layoff', 'retrenchment', 'dismissal']);
const EXIT_STATUSES = new Set(['draft', 'in_progress', 'pending_finance', 'pending_admin', 'pending_hr_final', 'completed', 'cancelled']);
const PROPERTY_CATEGORIES = new Set(['id_card', 'keys', 'laptop', 'phone', 'documents', 'cash', 'tools', 'uniform', 'other']);

export function hrPhase2TablesReady(db) {
  try {
    return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='hr_absence_reports'`).get());
  } catch {
    return false;
  }
}

function staffDisplayName(db, userId) {
  const u = db.prepare(`SELECT display_name, username FROM app_users WHERE id = ?`).get(userId);
  return u?.display_name || u?.username || userId;
}

function loadStaffBrief(db, userId) {
  const u = db.prepare(`SELECT id, display_name, username FROM app_users WHERE id = ?`).get(userId);
  if (!u) return null;
  const p = db.prepare(`SELECT * FROM hr_staff_profiles WHERE user_id = ?`).get(userId);
  return {
    userId: u.id,
    displayName: u.display_name || u.username,
    username: u.username,
    employeeNo: p?.employee_no || null,
    jobTitle: p?.job_title || null,
    department: p?.department || null,
    branchId: p?.branch_id || null,
    dateJoinedIso: p?.date_joined_iso || null,
    baseSalaryNgn: p?.base_salary_ngn ?? null,
    employmentType: p?.employment_type || null,
    contractEndIso: p?.contract_end_iso || null,
  };
}

function scopeBranchSql(scope, alias = 'ar') {
  if (scope.viewAll) return { clause: '', params: [] };
  return { clause: ` AND ${alias}.branch_id = ?`, params: [scope.branchId] };
}

function mapAbsenceRow(row, db) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    displayName: staffDisplayName(db, row.user_id),
    branchId: row.branch_id,
    department: row.department,
    absenceStartIso: row.absence_start_iso,
    expectedReturnIso: row.expected_return_iso,
    actualReturnIso: row.actual_return_iso,
    reason: row.reason,
    absenceType: row.absence_type,
    illnessRelated: Boolean(row.illness_related),
    doctorNoteDocumentId: row.doctor_note_document_id,
    status: row.status,
    reportedByUserId: row.reported_by_user_id,
    reviewedByUserId: row.reviewed_by_user_id,
    reviewedAtIso: row.reviewed_at_iso,
    reviewNote: row.review_note,
    createdAtIso: row.created_at_iso,
    updatedAtIso: row.updated_at_iso,
  };
}

// ── ABSENCE REPORTS ───────────────────────────────────────────

export function listHrAbsenceReports(db, scope, filters = {}) {
  if (!hrPhase2TablesReady(db)) return [];
  const { clause, params: scopeParams } = scopeBranchSql(scope, 'ar');
  let sql = `SELECT ar.* FROM hr_absence_reports ar WHERE 1=1${clause}`;
  const params = [...scopeParams];
  if (filters.userId) {
    sql += ' AND ar.user_id = ?';
    params.push(String(filters.userId));
  }
  if (filters.status) {
    sql += ' AND ar.status = ?';
    params.push(String(filters.status));
  }
  if (filters.absenceType) {
    sql += ' AND ar.absence_type = ?';
    params.push(String(filters.absenceType));
  }
  if (filters.fromIso) {
    sql += ' AND ar.absence_start_iso >= ?';
    params.push(String(filters.fromIso).slice(0, 10));
  }
  if (filters.toIso) {
    sql += ' AND ar.absence_start_iso <= ?';
    params.push(String(filters.toIso).slice(0, 10));
  }
  sql += ' ORDER BY ar.absence_start_iso DESC, ar.created_at_iso DESC';
  return db.prepare(sql).all(...params).map((r) => mapAbsenceRow(r, db));
}

export function createHrAbsenceReport(db, actor, body) {
  if (!hrPhase2TablesReady(db)) return { ok: false, error: 'Absence reporting not initialised.' };
  const userId = String(body?.userId || actor?.id || '').trim();
  const reason = String(body?.reason || '').trim();
  const absenceStartIso = String(body?.absenceStartIso || '').slice(0, 10);
  const expectedReturnIso = String(body?.expectedReturnIso || '').slice(0, 10);
  const absenceType = String(body?.absenceType || 'other').trim().toLowerCase();
  const illnessRelated = Boolean(body?.illnessRelated);
  if (!userId || !reason || !absenceStartIso || !expectedReturnIso) {
    return { ok: false, error: 'userId, reason, absenceStartIso, and expectedReturnIso are required.' };
  }
  if (!ABSENCE_TYPES.has(absenceType)) return { ok: false, error: 'Invalid absence type.' };
  const staff = loadStaffBrief(db, userId);
  if (!staff) return { ok: false, error: 'Staff not found.' };
  const days = diffDays(absenceStartIso, expectedReturnIso);
  const doctorNoteDocumentId = String(body?.doctorNoteDocumentId || '').trim() || null;
  if (illnessRelated && days > 1 && !doctorNoteDocumentId) {
    return { ok: false, error: "Doctor's note document is required for illness-related absences over 1 day." };
  }
  if (doctorNoteDocumentId) {
    const doc = db.prepare(`SELECT id FROM hr_staff_documents WHERE id = ? AND user_id = ?`).get(doctorNoteDocumentId, userId);
    if (!doc) return { ok: false, error: 'Doctor note document not found for this staff member.' };
  }
  const id = newId('HRABS');
  const now = nowIso();
  db.prepare(
    `INSERT INTO hr_absence_reports (
      id, user_id, branch_id, department, absence_start_iso, expected_return_iso, actual_return_iso,
      reason, absence_type, illness_related, doctor_note_document_id, status,
      reported_by_user_id, created_at_iso, updated_at_iso
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    userId,
    staff.branchId,
    staff.department,
    absenceStartIso,
    expectedReturnIso,
    null,
    reason,
    absenceType,
    illnessRelated ? 1 : 0,
    doctorNoteDocumentId,
    'reported',
    actor?.id || userId,
    now,
    now
  );
  appendHrAuditEvent(db, {
    actorUserId: actor?.id,
    action: 'hr.absence.reported',
    entityKind: 'hr_absence_report',
    entityId: id,
    userId,
    branchId: staff.branchId,
    detail: { absenceType, absenceStartIso, expectedReturnIso },
  });
  return { ok: true, report: mapAbsenceRow(db.prepare(`SELECT * FROM hr_absence_reports WHERE id = ?`).get(id), db) };
}

export function reviewHrAbsenceReport(db, actor, reportId, body) {
  if (!hrPhase2TablesReady(db)) return { ok: false, error: 'Absence reporting not initialised.' };
  const row = db.prepare(`SELECT * FROM hr_absence_reports WHERE id = ?`).get(String(reportId || '').trim());
  if (!row) return { ok: false, error: 'Absence report not found.' };
  const approve = body?.approve === true;
  const status = approve ? 'approved' : String(body?.status || 'rejected').trim();
  if (!['approved', 'rejected', 'unauthorized', 'hr_review'].includes(status)) {
    return { ok: false, error: 'Invalid review status.' };
  }
  const reviewNote = String(body?.reviewNote || body?.note || '').trim() || null;
  const now = nowIso();
  db.prepare(
    `UPDATE hr_absence_reports SET status = ?, reviewed_by_user_id = ?, reviewed_at_iso = ?, review_note = ?, updated_at_iso = ? WHERE id = ?`
  ).run(status, actor?.id, now, reviewNote, now, row.id);
  appendHrAuditEvent(db, {
    actorUserId: actor?.id,
    action: `hr.absence.${status}`,
    entityKind: 'hr_absence_report',
    entityId: row.id,
    userId: row.user_id,
    detail: { reviewNote },
  });
  return { ok: true, report: mapAbsenceRow(db.prepare(`SELECT * FROM hr_absence_reports WHERE id = ?`).get(row.id), db) };
}

export function closeHrAbsenceReport(db, actor, reportId, body) {
  if (!hrPhase2TablesReady(db)) return { ok: false, error: 'Absence reporting not initialised.' };
  const row = db.prepare(`SELECT * FROM hr_absence_reports WHERE id = ?`).get(String(reportId || '').trim());
  if (!row) return { ok: false, error: 'Absence report not found.' };
  const actualReturnIso = String(body?.actualReturnIso || '').slice(0, 10) || null;
  const now = nowIso();
  db.prepare(
    `UPDATE hr_absence_reports SET status = 'closed', actual_return_iso = ?, updated_at_iso = ? WHERE id = ?`
  ).run(actualReturnIso, now, row.id);
  appendHrAuditEvent(db, {
    actorUserId: actor?.id,
    action: 'hr.absence.closed',
    entityKind: 'hr_absence_report',
    entityId: row.id,
    userId: row.user_id,
    detail: { actualReturnIso },
  });
  return { ok: true, report: mapAbsenceRow(db.prepare(`SELECT * FROM hr_absence_reports WHERE id = ?`).get(row.id), db) };
}

function hasApprovedAbsenceCover(db, userId, dayIso) {
  const row = db
    .prepare(
      `SELECT 1 FROM hr_absence_reports
       WHERE user_id = ? AND absence_start_iso <= ? AND expected_return_iso >= ?
       AND status IN ('reported','hr_review','approved','closed') LIMIT 1`
    )
    .get(userId, dayIso, dayIso);
  return Boolean(row);
}

export function getHrAbsenceAlerts(db, scope) {
  if (!hrPhase2TablesReady(db)) return { voluntaryTerminationRisk: [], unauthorizedNoReport: [] };
  const staff = listHrStaff(db, scope, { includeInactive: false });
  const voluntaryTerminationRisk = [];
  const unauthorizedNoReport = [];
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 14);
  const cutoffIso = cutoff.toISOString().slice(0, 10);

  for (const s of staff) {
    const branchId = s.branchId;
    // Collect absent days from daily roll + attendance events
    const absentDays = new Set();
    try {
      const rolls = db
        .prepare(`SELECT day_iso, rows_json FROM hr_daily_roll_calls WHERE branch_id = ? AND day_iso >= ?`)
        .all(branchId, cutoffIso);
      for (const roll of rolls) {
        const rows = safeJsonParse(roll.rows_json, []);
        for (const r of rows) {
          if (r.userId === s.userId && String(r.status) === 'absent') absentDays.add(roll.day_iso);
        }
      }
    } catch { /* ignore */ }
    try {
      const evts = db
        .prepare(
          `SELECT event_date_iso FROM hr_attendance_events WHERE user_id = ? AND status = 'absent' AND event_date_iso >= ?`
        )
        .all(s.userId, cutoffIso);
      for (const e of evts) absentDays.add(e.event_date_iso);
    } catch { /* ignore */ }

    const sorted = [...absentDays].sort();
    let streak = 0;
    let streakStart = null;
    let last = null;
    for (const day of sorted) {
      if (!hasApprovedAbsenceCover(db, s.userId, day)) {
        if (last && Date.parse(day) - Date.parse(last) <= 2 * 86400000) {
          streak++;
        } else {
          streak = 1;
          streakStart = day;
        }
        last = day;
        if (streak >= 3) {
          voluntaryTerminationRisk.push({
            userId: s.userId,
            displayName: s.displayName,
            branchId: s.branchId,
            consecutiveDays: streak,
            streakStartIso: streakStart,
            lastAbsentIso: day,
            alertType: 'voluntary_termination_risk',
            message: 'Three consecutive work days absent without approved absence report — HR action required.',
          });
          break;
        }
      } else {
        streak = 0;
        last = null;
      }
    }
    for (const day of sorted) {
      if (!hasApprovedAbsenceCover(db, s.userId, day)) {
        unauthorizedNoReport.push({
          userId: s.userId,
          displayName: s.displayName,
          branchId: s.branchId,
          dayIso: day,
          alertType: 'unauthorized_absence',
        });
      }
    }
  }
  return { voluntaryTerminationRisk, unauthorizedNoReport };
}

// ── EXIT CLEARANCE ────────────────────────────────────────────

function mapExitClearance(row, db) {
  if (!row) return null;
  const items = db.prepare(`SELECT * FROM hr_exit_property_items WHERE clearance_id = ? ORDER BY created_at_iso ASC`).all(row.id);
  return {
    id: row.id,
    userId: row.user_id,
    displayName: staffDisplayName(db, row.user_id),
    separationType: row.separation_type,
    initiatedByUserId: row.initiated_by_user_id,
    lastWorkingDayIso: row.last_working_day_iso,
    reason: row.reason,
    status: row.status,
    financeClearedByUserId: row.finance_cleared_by_user_id,
    financeClearedAtIso: row.finance_cleared_at_iso,
    financeNotes: row.finance_notes,
    adminClearedByUserId: row.admin_cleared_by_user_id,
    adminClearedAtIso: row.admin_cleared_at_iso,
    adminNotes: row.admin_notes,
    hrFinalClearedByUserId: row.hr_final_cleared_by_user_id,
    hrFinalClearedAtIso: row.hr_final_cleared_at_iso,
    hrFinalNotes: row.hr_final_notes,
    completedAtIso: row.completed_at_iso,
    notes: row.notes,
    createdAtIso: row.created_at_iso,
    updatedAtIso: row.updated_at_iso,
    propertyItems: items.map((it) => ({
      id: it.id,
      itemName: it.item_name,
      itemCategory: it.item_category,
      serialOrReference: it.serial_or_reference,
      conditionOnReturn: it.condition_on_return,
      expectedReturn: Boolean(it.expected_return),
      returned: Boolean(it.returned),
      waived: Boolean(it.waived),
      waivedNote: it.waived_note,
      returnedAtIso: it.returned_at_iso,
      receivedByUserId: it.received_by_user_id,
      notes: it.notes,
    })),
    outstandingLoans: getOutstandingLoansForUser(db, row.user_id),
  };
}

function getOutstandingLoansForUser(db, userId) {
  if (!hrTablesReady(db)) return [];
  const rows = db
    .prepare(`SELECT id, payload_json FROM hr_requests WHERE user_id = ? AND kind = 'loan' AND status = 'approved'`)
    .all(userId);
  const out = [];
  for (const r of rows) {
    const p = safeJsonParse(r.payload_json, {});
    const outstanding = Number(p.principalOutstandingNgn);
    if (p.loanDisbursedAtIso && p.deductionsActive !== false && outstanding > 0) {
      out.push({ requestId: r.id, principalOutstandingNgn: Math.round(outstanding) });
    }
  }
  return out;
}

export function listHrExitClearance(db, scope, filters = {}) {
  if (!hrPhase2TablesReady(db)) return [];
  const staffIds = new Set(listHrStaff(db, scope, { includeInactive: true }).map((s) => s.userId));
  let rows = db.prepare(`SELECT * FROM hr_exit_clearance ORDER BY created_at_iso DESC`).all();
  if (!scope.viewAll) {
    rows = rows.filter((r) => {
      const p = db.prepare(`SELECT branch_id FROM hr_staff_profiles WHERE user_id = ?`).get(r.user_id);
      return p?.branch_id === scope.branchId;
    });
  }
  if (filters.userId) rows = rows.filter((r) => r.user_id === String(filters.userId));
  if (filters.status) rows = rows.filter((r) => r.status === String(filters.status));
  return rows.filter((r) => staffIds.has(r.user_id)).map((r) => mapExitClearance(r, db));
}

export function getHrExitClearance(db, clearanceId, scope = null) {
  if (!hrPhase2TablesReady(db)) return { ok: false, error: 'Exit clearance not initialised.' };
  const row = db.prepare(`SELECT * FROM hr_exit_clearance WHERE id = ?`).get(String(clearanceId || '').trim());
  if (!row) return { ok: false, error: 'Clearance not found.' };
  if (scope) {
    const gate = assertStaffUserIdInHrScope(db, scope, row.user_id);
    if (!gate.ok) return { ok: false, error: 'Clearance not found.' };
  }
  return { ok: true, clearance: mapExitClearance(row, db) };
}

export function createHrExitClearance(db, actor, body) {
  if (!hrPhase2TablesReady(db)) return { ok: false, error: 'Exit clearance not initialised.' };
  const userId = String(body?.userId || '').trim();
  const separationType = String(body?.separationType || '').trim().toLowerCase();
  const lastWorkingDayIso = String(body?.lastWorkingDayIso || '').slice(0, 10);
  const reason = String(body?.reason || '').trim() || null;
  if (!userId || !EXIT_SEPARATION_TYPES.has(separationType) || !lastWorkingDayIso) {
    return { ok: false, error: 'userId, separationType, and lastWorkingDayIso are required.' };
  }
  const staff = loadStaffBrief(db, userId);
  if (!staff) return { ok: false, error: 'Staff not found.' };
  const id = newId('HREX');
  const now = nowIso();
  db.prepare(
    `INSERT INTO hr_exit_clearance (
      id, user_id, separation_type, initiated_by_user_id, last_working_day_iso, reason,
      status, notes, created_at_iso, updated_at_iso
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(id, userId, separationType, actor?.id, lastWorkingDayIso, reason, 'in_progress', String(body?.notes || '').trim() || null, now, now);

  const defaultItems = [
    { itemName: 'Staff ID Card', itemCategory: 'id_card' },
    { itemName: 'Office Keys', itemCategory: 'keys' },
    { itemName: 'Company Laptop / Device', itemCategory: 'laptop' },
    { itemName: 'Company Phone', itemCategory: 'phone' },
    { itemName: 'Uniform / PPE', itemCategory: 'uniform' },
  ];
  const items = Array.isArray(body?.propertyItems) && body.propertyItems.length ? body.propertyItems : defaultItems;
  for (const it of items) {
    const iid = newId('HREXI');
    db.prepare(
      `INSERT INTO hr_exit_property_items (
        id, clearance_id, item_name, item_category, serial_or_reference, expected_return, created_at_iso, updated_at_iso
      ) VALUES (?,?,?,?,?,?,?,?)`
    ).run(
      iid,
      id,
      String(it.itemName || it.item_name || 'Item').trim(),
      PROPERTY_CATEGORIES.has(String(it.itemCategory || it.item_category || 'other')) ? String(it.itemCategory || it.item_category) : 'other',
      String(it.serialOrReference || it.serial_or_reference || '').trim() || null,
      it.expectedReturn === false ? 0 : 1,
      now,
      now
    );
  }

  patchHrStaffSeparation(db, actor, userId, {
    status: 'separating',
    lastWorkingDayIso,
    reason: reason || separationType,
  });

  appendHrAuditEvent(db, {
    actorUserId: actor?.id,
    action: 'hr.exit.initiated',
    entityKind: 'hr_exit_clearance',
    entityId: id,
    userId,
    detail: { separationType, lastWorkingDayIso },
  });
  return { ok: true, clearance: mapExitClearance(db.prepare(`SELECT * FROM hr_exit_clearance WHERE id = ?`).get(id), db) };
}

export function addHrExitPropertyItem(db, actor, clearanceId, body) {
  const ex = getHrExitClearance(db, clearanceId);
  if (!ex.ok) return ex;
  const id = newId('HREXI');
  const now = nowIso();
  db.prepare(
    `INSERT INTO hr_exit_property_items (
      id, clearance_id, item_name, item_category, serial_or_reference, expected_return, created_at_iso, updated_at_iso
    ) VALUES (?,?,?,?,?,?,?,?)`
  ).run(
    id,
    ex.clearance.id,
    String(body?.itemName || '').trim() || 'Item',
    PROPERTY_CATEGORIES.has(String(body?.itemCategory || 'other')) ? body.itemCategory : 'other',
    String(body?.serialOrReference || '').trim() || null,
    body?.expectedReturn === false ? 0 : 1,
    now,
    now
  );
  return { ok: true, item: mapExitClearance(db.prepare(`SELECT * FROM hr_exit_clearance WHERE id = ?`).get(ex.clearance.id), db).propertyItems.find((x) => x.id === id) };
}

export function patchHrExitPropertyItem(db, actor, clearanceId, itemId, body) {
  const ex = getHrExitClearance(db, clearanceId);
  if (!ex.ok) return ex;
  const item = db.prepare(`SELECT * FROM hr_exit_property_items WHERE id = ? AND clearance_id = ?`).get(itemId, clearanceId);
  if (!item) return { ok: false, error: 'Property item not found.' };
  const now = nowIso();
  const returned = body?.returned === true ? 1 : body?.returned === false ? 0 : item.returned;
  const waived = body?.waived === true ? 1 : body?.waived === false ? 0 : item.waived;
  db.prepare(
    `UPDATE hr_exit_property_items SET
      returned = ?, waived = ?, waived_note = ?, condition_on_return = ?,
      returned_at_iso = ?, received_by_user_id = ?, notes = ?, updated_at_iso = ?
     WHERE id = ? AND clearance_id = ?`
  ).run(
    returned,
    waived,
    body?.waivedNote !== undefined ? String(body.waivedNote || '').trim() || null : item.waived_note,
    body?.conditionOnReturn !== undefined ? String(body.conditionOnReturn || '').trim() || null : item.condition_on_return,
    returned ? now : item.returned_at_iso,
    returned ? actor?.id : item.received_by_user_id,
    body?.notes !== undefined ? String(body.notes || '').trim() || null : item.notes,
    now,
    itemId,
    clearanceId
  );
  return getHrExitClearance(db, clearanceId);
}

function advanceExitStatus(db, clearanceId, status, extra = {}) {
  const now = nowIso();
  const sets = ['status = ?', 'updated_at_iso = ?'];
  const params = [status, now];
  for (const [k, v] of Object.entries(extra)) {
    sets.push(`${k} = ?`);
    params.push(v);
  }
  params.push(clearanceId);
  db.prepare(`UPDATE hr_exit_clearance SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

export function financeClearHrExit(db, actor, clearanceId, body) {
  const ex = getHrExitClearance(db, clearanceId);
  if (!ex.ok) return ex;
  advanceExitStatus(db, clearanceId, 'pending_admin', {
    finance_cleared_by_user_id: actor?.id,
    finance_cleared_at_iso: nowIso(),
    finance_notes: String(body?.notes || '').trim() || null,
  });
  appendHrAuditEvent(db, { actorUserId: actor?.id, action: 'hr.exit.finance_cleared', entityKind: 'hr_exit_clearance', entityId: clearanceId });
  return getHrExitClearance(db, clearanceId);
}

export function adminClearHrExit(db, actor, clearanceId, body) {
  const ex = getHrExitClearance(db, clearanceId);
  if (!ex.ok) return ex;
  if (!ex.clearance.financeClearedByUserId) {
    return { ok: false, error: 'Finance clearance is required before admin clearance.' };
  }
  advanceExitStatus(db, clearanceId, 'pending_hr_final', {
    admin_cleared_by_user_id: actor?.id,
    admin_cleared_at_iso: nowIso(),
    admin_notes: String(body?.notes || '').trim() || null,
  });
  appendHrAuditEvent(db, { actorUserId: actor?.id, action: 'hr.exit.admin_cleared', entityKind: 'hr_exit_clearance', entityId: clearanceId });
  return getHrExitClearance(db, clearanceId);
}

export function hrFinalClearHrExit(db, actor, clearanceId, body) {
  const ex = getHrExitClearance(db, clearanceId);
  if (!ex.ok) return ex;
  if (!ex.clearance.financeClearedByUserId || !ex.clearance.adminClearedByUserId) {
    return { ok: false, error: 'Finance and admin clearance required before HR final clearance.' };
  }
  const pending = (ex.clearance.propertyItems || []).filter(
    (it) => it.expectedReturn && !it.returned && !it.waived
  );
  if (pending.length) {
    return { ok: false, error: `Cannot complete: ${pending.length} property item(s) not returned or waived.` };
  }
  const now = nowIso();
  advanceExitStatus(db, clearanceId, 'completed', {
    hr_final_cleared_by_user_id: actor?.id,
    hr_final_cleared_at_iso: now,
    hr_final_notes: String(body?.notes || '').trim() || null,
    completed_at_iso: now,
  });
  patchHrStaffSeparation(db, actor, ex.clearance.userId, { status: 'separated', lastWorkingDayIso: ex.clearance.lastWorkingDayIso });
  appendHrAuditEvent(db, { actorUserId: actor?.id, action: 'hr.exit.completed', entityKind: 'hr_exit_clearance', entityId: clearanceId });
  return getHrExitClearance(db, clearanceId);
}

export function exportHrExitClearancePdf(db, clearanceId) {
  const ex = getHrExitClearance(db, clearanceId);
  if (!ex.ok) return ex;
  const c = ex.clearance;
  const staff = loadStaffBrief(db, c.userId);
  const content = buildHrLetterContent('exit_clearance', staff || {}, {
    separationType: c.separationType,
    lastWorkingDay: c.lastWorkingDayIso,
  });
  const lines = [
    ...content.split(/\r?\n/),
    '',
    'PROPERTY CHECKLIST:',
    ...(c.propertyItems || []).map(
      (it, i) =>
        `${i + 1}. ${it.itemName} — ${it.returned ? 'Returned' : it.waived ? 'Waived' : 'Pending'}`
    ),
  ];
  const pdf = buildSimpleTextPdf([{ lines }]);
  return { ok: true, pdf, filename: `exit-clearance-${c.userId}.pdf` };
}

// ── TEMPORARY EMPLOYEE ALERTS ─────────────────────────────────

export function getTemporaryEmployeeAlerts(db, scope) {
  const staff = listHrStaff(db, scope, { includeInactive: false });
  const profileByUser = new Map();
  try {
    const ids = staff.map((s) => s.userId);
    if (ids.length) {
      const placeholders = ids.map(() => '?').join(',');
      const rows = db
        .prepare(
          `SELECT user_id, employment_type, date_joined_iso, contract_end_iso FROM hr_staff_profiles WHERE user_id IN (${placeholders})`
        )
        .all(...ids);
      for (const r of rows) profileByUser.set(r.user_id, r);
    }
  } catch { /* ignore */ }
  const today = new Date().toISOString().slice(0, 10);
  const in30 = new Date();
  in30.setDate(in30.getDate() + 30);
  const in30Iso = in30.toISOString().slice(0, 10);
  const missingContractEnd = [];
  const contractEndingSoon = [];
  const exceedsSixMonths = [];
  const pastContractEnd = [];

  for (const s of staff) {
    const prof = profileByUser.get(s.userId) || {};
    const et = String(prof.employment_type || s.employmentType || '').toLowerCase();
    if (!et.includes('contract') && !et.includes('temp')) continue;
    const joined = prof.date_joined_iso || s.dateJoinedIso;
    const end = prof.contract_end_iso || null;
    if (!end) {
      missingContractEnd.push({ userId: s.userId, displayName: s.displayName, branchId: s.branchId, alertType: 'missing_contract_end' });
      continue;
    }
    if (end < today) {
      pastContractEnd.push({ userId: s.userId, displayName: s.displayName, branchId: s.branchId, contractEndIso: end, alertType: 'past_contract_end' });
    } else if (end <= in30Iso) {
      contractEndingSoon.push({ userId: s.userId, displayName: s.displayName, branchId: s.branchId, contractEndIso: end, alertType: 'contract_ending_soon' });
    }
    if (joined) {
      const months = (Date.parse(end) - Date.parse(joined)) / (30.44 * 86400000);
      if (months > 6.05) {
        exceedsSixMonths.push({
          userId: s.userId,
          displayName: s.displayName,
          branchId: s.branchId,
          dateJoinedIso: joined,
          contractEndIso: end,
          alertType: 'exceeds_six_months',
        });
      }
    }
  }
  return { missingContractEnd, contractEndingSoon, exceedsSixMonths, pastContractEnd };
}

// ── PROMOTION DUE ─────────────────────────────────────────────

export function getPromotionDueReport(db, scope, opts = {}) {
  const staff = listHrStaff(db, scope, { includeInactive: false });
  const rows = [];
  const now = Date.now();
  for (const s of staff) {
    let lastPromotionIso = s.dateJoinedIso;
    try {
      const hist = db
        .prepare(
          `SELECT effective_from_iso, reason FROM hr_salary_history WHERE user_id = ? ORDER BY effective_from_iso DESC LIMIT 1`
        )
        .get(s.userId);
      if (hist?.effective_from_iso) lastPromotionIso = hist.effective_from_iso;
    } catch { /* ignore */ }
    const lastMs = Date.parse(String(lastPromotionIso || '').slice(0, 10));
    const yearsSince = Number.isFinite(lastMs) ? (now - lastMs) / (365.25 * 86400000) : 0;
    const disc = getStaffDisciplinaryQueryCount(db, s.userId);
    let eligibility = 'not_due';
    let suggestedAction = 'Monitor';
    if (yearsSince >= 3) {
      if (disc.promotionBlocked) {
        eligibility = 'blocked_by_discipline';
        suggestedAction = 'Promotion blocked — 2nd query on record';
      } else if (disc.terminationDue) {
        eligibility = 'termination_review';
        suggestedAction = 'Disciplinary review — 3rd query';
      } else {
        eligibility = 'due';
        suggestedAction = 'Apply promotion / increment';
      }
    } else if (yearsSince >= 2.5) {
      eligibility = 'approaching';
      suggestedAction = 'Prepare appraisal';
    }
    if (opts.dueOnly && eligibility !== 'due') continue;
    rows.push({
      userId: s.userId,
      displayName: s.displayName,
      branchId: s.branchId,
      department: s.department,
      jobTitle: s.jobTitle,
      salaryLevel: s.promotionGrade ?? s.salaryLevel ?? null,
      baseSalaryNgn: s.baseSalaryNgn,
      lastPromotionIso,
      yearsSince: Math.round(yearsSince * 10) / 10,
      queryCount: disc.queryCount,
      eligibility,
      suggestedAction,
      promotionBlocked: disc.promotionBlocked,
    });
  }
  rows.sort((a, b) => b.yearsSince - a.yearsSince);
  return rows;
}

// ── LETTERS FROM TEMPLATE ─────────────────────────────────────

export function generateHrLetterFromTemplate(db, actor, body) {
  if (!hrTablesReady(db)) return { ok: false, error: 'HR module not initialised.' };
  const userId = String(body?.userId || '').trim();
  const letterKind = String(body?.letterKind || 'employment').trim().toLowerCase();
  if (!userId) return { ok: false, error: 'userId is required.' };
  const staff = loadStaffBrief(db, userId);
  if (!staff) return { ok: false, error: 'Staff not found.' };
  const extra = body?.extraData || body?.extra || body;
  const content = buildHrLetterContent(letterKind, staff, extra);
  const id = newId('HRL');
  const now = nowIso();
  const sourceRecordKind = String(body?.sourceRecordKind || extra?.sourceRecordKind || '').trim() || null;
  const sourceRecordId = String(body?.sourceRecordId || extra?.sourceRecordId || '').trim() || null;
  try {
    db.prepare(
      `INSERT INTO hr_employment_letters (id, user_id, letter_kind, content_text, issued_at_iso, issued_by_user_id, source_record_kind, source_record_id)
       VALUES (?,?,?,?,?,?,?,?)`
    ).run(id, userId, letterKind, content, now, actor?.id, sourceRecordKind, sourceRecordId);
  } catch {
    db.prepare(
      `INSERT INTO hr_employment_letters (id, user_id, letter_kind, content_text, issued_at_iso, issued_by_user_id)
       VALUES (?,?,?,?,?,?)`
    ).run(id, userId, letterKind, content, now, actor?.id);
  }
  appendHrAuditEvent(db, {
    actorUserId: actor?.id,
    action: 'hr.letter.generated',
    entityKind: 'hr_employment_letter',
    entityId: id,
    userId,
    detail: { letterKind },
  });
  return { ok: true, id, contentText: content, letterKind };
}

export function generateLeaveDecisionLetter(db, actor, body) {
  if (!hrTablesReady(db)) return { ok: false, error: 'HR module not initialised.' };
  const requestId = String(body?.requestId || '').trim();
  const kind = String(body?.letterKind || body?.kind || '').trim().toLowerCase();
  if (!requestId || !['leave_approval', 'leave_rejection'].includes(kind)) {
    return { ok: false, error: 'requestId and letterKind (leave_approval|leave_rejection) are required.' };
  }
  const req = db.prepare(`SELECT * FROM hr_requests WHERE id = ? AND kind = 'leave'`).get(requestId);
  if (!req) return { ok: false, error: 'Leave request not found.' };
  if (kind === 'leave_approval' && req.status !== 'approved') {
    return { ok: false, error: 'Leave approval letter requires an approved request.' };
  }
  if (kind === 'leave_rejection' && !['rejected', 'hr_rejected', 'gm_rejected'].includes(String(req.status))) {
    return { ok: false, error: 'Leave rejection letter requires a rejected request.' };
  }
  const payload = safeJsonParse(req.payload_json, {});
  const leave = db.prepare(`SELECT * FROM hr_request_leave WHERE request_id = ?`).get(requestId);
  const extra = {
    leaveType: leave?.leave_type || payload.leaveType || 'leave',
    startDate: leave?.start_date_iso || payload.startDateIso,
    endDate: leave?.end_date_iso || payload.endDateIso,
    daysRequested: leave?.days_requested ?? payload.daysRequested,
    rejectionReason: payload.rejectionReason || payload.reviewNote || body?.rejectionReason,
  };
  return generateHrLetterFromTemplate(db, actor, { userId: req.user_id, letterKind: kind, extra });
}
