/**
 * HR transfer request workflow (Phase 4).
 * @module server/hrTransferRequests
 */

import { hrTablesReady, upsertHrStaffProfile } from './hrOps.js';

const TRANSFER_STATUSES = [
  'draft',
  'submitted',
  'branch_review',
  'hr_review',
  'gm_approval',
  'approved',
  'rejected',
  'completed',
  'cancelled',
];

const TRANSFER_TYPES = [
  'inter_branch',
  'in_branch_department',
  'hq_to_branch',
  'branch_to_hq',
  'role_designation',
  'temporary',
  'permanent',
];

function nowIso() {
  return new Date().toISOString();
}

function newId() {
  return `xfer_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export function hrTransferRequestsTableReady(db) {
  try {
    return Boolean(
      db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='hr_transfer_requests'`).get()
    );
  } catch {
    return false;
  }
}

function mapRow(row, staffName) {
  return {
    id: row.id,
    userId: row.user_id,
    staffDisplayName: staffName || row.staffDisplayName,
    transferType: row.transfer_type,
    fromBranchId: row.from_branch_id,
    toBranchId: row.to_branch_id,
    fromDepartment: row.from_department,
    toDepartment: row.to_department,
    fromDesignation: row.from_designation,
    toDesignation: row.to_designation,
    effectiveDateIso: row.effective_date_iso,
    reason: row.reason,
    status: row.status,
    requestedByUserId: row.requested_by_user_id,
    recommendedByUserId: row.recommended_by_user_id,
    approvedByUserId: row.approved_by_user_id,
    notes: row.notes,
    createdAtIso: row.created_at_iso,
    updatedAtIso: row.updated_at_iso,
    completedAtIso: row.completed_at_iso,
  };
}

export function listHrTransferRequests(db, scope = {}, filters = {}) {
  if (!hrTransferRequestsTableReady(db)) return [];
  let sql = `SELECT t.*, u.display_name AS staffDisplayName FROM hr_transfer_requests t
             JOIN app_users u ON u.id = t.user_id WHERE 1=1`;
  const params = [];
  if (scope.branchId) {
    sql += ` AND (t.from_branch_id = ? OR t.to_branch_id = ?)`;
    params.push(scope.branchId, scope.branchId);
  }
  if (filters.userId) {
    sql += ` AND t.user_id = ?`;
    params.push(filters.userId);
  }
  if (filters.status) {
    sql += ` AND t.status = ?`;
    params.push(filters.status);
  }
  if (filters.transferType) {
    sql += ` AND t.transfer_type = ?`;
    params.push(filters.transferType);
  }
  if (filters.pendingOnly) {
    sql += ` AND t.status IN ('submitted','branch_review','hr_review','gm_approval','approved')`;
  }
  sql += ` ORDER BY t.created_at_iso DESC LIMIT 500`;
  return db.prepare(sql).all(...params).map((r) => mapRow(r));
}

export function getHrTransferRequest(db, id) {
  if (!hrTransferRequestsTableReady(db)) return null;
  const row = db
    .prepare(
      `SELECT t.*, u.display_name AS staffDisplayName FROM hr_transfer_requests t
       JOIN app_users u ON u.id = t.user_id WHERE t.id = ?`
    )
    .get(id);
  return row ? mapRow(row) : null;
}

export function createHrTransferRequest(db, body, actor) {
  if (!hrTablesReady(db) || !hrTransferRequestsTableReady(db)) {
    return { ok: false, error: 'Transfer module not initialised.' };
  }
  const userId = String(body?.userId || '').trim();
  const transferType = String(body?.transferType || 'inter_branch').trim();
  if (!userId) return { ok: false, error: 'Employee is required.' };
  if (!TRANSFER_TYPES.includes(transferType)) return { ok: false, error: 'Invalid transfer type.' };
  const effectiveDateIso = String(body?.effectiveDateIso || body?.effectiveDate || '').slice(0, 10);
  if (!effectiveDateIso) return { ok: false, error: 'Effective date is required.' };
  const reason = String(body?.reason || '').trim();
  if (!reason) return { ok: false, error: 'Reason is required.' };

  const profile = db.prepare(`SELECT * FROM hr_staff_profiles WHERE user_id = ?`).get(userId);
  const id = newId();
  const ts = nowIso();
  const status = body?.submit ? 'submitted' : 'draft';
  db.prepare(
    `INSERT INTO hr_transfer_requests (
      id, user_id, transfer_type, from_branch_id, to_branch_id, from_department, to_department,
      from_designation, to_designation, effective_date_iso, reason, status, requested_by_user_id,
      recommended_by_user_id, notes, created_at_iso, updated_at_iso
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    userId,
    transferType,
    body?.fromBranchId || profile?.branch_id || null,
    body?.toBranchId || null,
    body?.fromDepartment || profile?.department || null,
    body?.toDepartment || null,
    body?.fromDesignation || profile?.job_title || null,
    body?.toDesignation || null,
    effectiveDateIso,
    reason,
    status,
    actor?.id || null,
    body?.recommendedByUserId || null,
    body?.notes || null,
    ts,
    ts
  );
  return { ok: true, transfer: getHrTransferRequest(db, id) };
}

export function patchHrTransferRequest(db, id, body, actor) {
  if (!hrTransferRequestsTableReady(db)) return { ok: false, error: 'Transfer module not initialised.' };
  const row = db.prepare(`SELECT * FROM hr_transfer_requests WHERE id = ?`).get(id);
  if (!row) return { ok: false, error: 'Transfer not found.' };

  const action = String(body?.action || '').trim();
  const ts = nowIso();
  let status = row.status;

  if (action === 'submit' && row.status === 'draft') status = 'submitted';
  else if (action === 'branch_review' && ['submitted'].includes(row.status)) status = 'branch_review';
  else if (action === 'hr_review' && ['submitted', 'branch_review'].includes(row.status)) status = 'hr_review';
  else if (action === 'gm_approval' && ['hr_review'].includes(row.status)) status = 'gm_approval';
  else if (action === 'approve' && ['submitted', 'branch_review', 'hr_review', 'gm_approval'].includes(row.status)) {
    status = 'approved';
  } else if (action === 'reject') status = 'rejected';
  else if (action === 'cancel' && !['completed', 'cancelled'].includes(row.status)) status = 'cancelled';
  else if (action === 'complete' && row.status === 'approved') {
    const complete = completeHrTransferRequest(db, id, actor);
    return complete;
  } else if (!action) {
    db.prepare(
      `UPDATE hr_transfer_requests SET
        to_branch_id = COALESCE(?, to_branch_id),
        to_department = COALESCE(?, to_department),
        to_designation = COALESCE(?, to_designation),
        effective_date_iso = COALESCE(?, effective_date_iso),
        reason = COALESCE(?, reason),
        notes = COALESCE(?, notes),
        updated_at_iso = ?
       WHERE id = ?`
    ).run(
      body?.toBranchId ?? null,
      body?.toDepartment ?? null,
      body?.toDesignation ?? null,
      body?.effectiveDateIso ? String(body.effectiveDateIso).slice(0, 10) : null,
      body?.reason ?? null,
      body?.notes ?? null,
      ts,
      id
    );
    return { ok: true, transfer: getHrTransferRequest(db, id) };
  } else {
    return { ok: false, error: `Cannot ${action} transfer in status ${row.status}.` };
  }

  db.prepare(
    `UPDATE hr_transfer_requests SET status = ?, updated_at_iso = ?,
     approved_by_user_id = CASE WHEN ? IN ('approved','rejected') THEN ? ELSE approved_by_user_id END
     WHERE id = ?`
  ).run(status, ts, action, actor?.id || null, id);

  return { ok: true, transfer: getHrTransferRequest(db, id) };
}

export function completeHrTransferRequest(db, id, actor) {
  const row = db.prepare(`SELECT * FROM hr_transfer_requests WHERE id = ?`).get(id);
  if (!row) return { ok: false, error: 'Transfer not found.' };
  if (row.status !== 'approved') return { ok: false, error: 'Transfer must be approved before completion.' };

  const ts = nowIso();
  const patch = {
    userId: row.user_id,
    branchId: row.to_branch_id || undefined,
    department: row.to_department || undefined,
    jobTitle: row.to_designation || undefined,
    branchChangeReason: `Transfer ${row.id}: ${row.reason || ''}`.trim(),
  };
  const r = upsertHrStaffProfile(db, actor?.id || null, patch);
  if (!r.ok) return r;

  db.prepare(
    `UPDATE hr_transfer_requests SET status = 'completed', completed_at_iso = ?, updated_at_iso = ? WHERE id = ?`
  ).run(ts, ts, id);

  return { ok: true, transfer: getHrTransferRequest(db, id) };
}

export function listPendingTransfersPastEffective(db, scope = {}) {
  if (!hrTransferRequestsTableReady(db)) return [];
  const today = new Date().toISOString().slice(0, 10);
  return listHrTransferRequests(db, scope, {}).filter(
    (t) => t.status === 'approved' && t.effectiveDateIso && t.effectiveDateIso <= today
  );
}

export { TRANSFER_STATUSES, TRANSFER_TYPES };
