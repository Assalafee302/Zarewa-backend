/**
 * HR transfer request workflow (Phase 4–5).
 * @module server/hrTransferRequests
 */

import { hrTablesReady, listHrStaff, upsertHrStaffProfile } from './hrOps.js';
import { userCanGmApproveHr } from './hrPermissions.js';
import { serviceYearsFromJoinedIso } from './hrBusinessRules.js';
import { evaluateTransferTenurePolicy } from './hrPolicyConstants.js';
import {
  notifyHrTransferOutcome,
  notifyHrTransferQueueHandoff,
  notifyHrTransferSubmitted,
} from './hrNotifications.js';

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

function safeJsonParse(v, fallback) {
  if (v == null || v === '') return fallback;
  try {
    return JSON.parse(String(v));
  } catch {
    return fallback;
  }
}

export function transferRequiresGmApproval(transferType) {
  return ['inter_branch', 'hq_to_branch', 'branch_to_hq'].includes(String(transferType || ''));
}

export function transferRequiresBranchReview(transferType) {
  return String(transferType || '') === 'inter_branch';
}

function initialStatusOnSubmit(transferType) {
  if (transferRequiresBranchReview(transferType)) return 'branch_review';
  return 'hr_review';
}

function parseTimeline(row) {
  return safeJsonParse(row?.timeline_json, []);
}

function appendTimeline(existing, entry) {
  const list = Array.isArray(existing) ? [...existing] : [];
  list.push(entry);
  return list;
}

function mapRow(row) {
  const timeline = parseTimeline(row);
  return {
    id: row.id,
    userId: row.user_id,
    staffDisplayName: row.staffDisplayName,
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
    rejectionReason: row.rejection_reason || null,
    resubmittedFromId: row.resubmitted_from_id || null,
    timeline,
    requiresGmApproval: transferRequiresGmApproval(row.transfer_type),
    createdAtIso: row.created_at_iso,
    updatedAtIso: row.updated_at_iso,
    completedAtIso: row.completed_at_iso,
  };
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

export function listHrTransferRequests(db, scope = {}, filters = {}) {
  if (!hrTransferRequestsTableReady(db)) return [];
  let sql = `SELECT t.*, u.display_name AS staffDisplayName FROM hr_transfer_requests t
             JOIN app_users u ON u.id = t.user_id WHERE 1=1`;
  const params = [];

  const scopeMode = scope.scopeMode || 'branch';
  if (!scope.viewAll && scopeMode !== 'org') {
    if (scopeMode === 'team' || scopeMode === 'department') {
      const staff = listHrStaff(db, scope, { includeInactive: true });
      const ids = staff.map((s) => s.userId);
      if (!ids.length) return [];
      sql += ` AND t.user_id IN (${ids.map(() => '?').join(',')})`;
      params.push(...ids);
    } else if (scope.branchId) {
      sql += ` AND (t.from_branch_id = ? OR t.to_branch_id = ?)`;
      params.push(scope.branchId, scope.branchId);
    }
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

  const yearsOfService = serviceYearsFromJoinedIso(profile?.date_joined_iso);
  const tenurePolicy = evaluateTransferTenurePolicy({
    transferType,
    yearsOfService,
    designationId: profile?.designation_id,
    jobTitle: profile?.job_title,
  });
  const policyWarnings = tenurePolicy.warnings || [];
  const notesWithWarnings =
    policyWarnings.length > 0
      ? [String(body?.notes || '').trim(), `Policy note: ${policyWarnings.join(' ')}`].filter(Boolean).join('\n')
      : String(body?.notes || '').trim() || null;

  const id = newId();
  const ts = nowIso();
  const status = body?.submit ? initialStatusOnSubmit(transferType) : 'draft';
  const timeline = appendTimeline([], {
    at: ts,
    action: body?.submit ? 'submit' : 'create',
    actorUserId: actor?.id || null,
    status,
    note: reason,
  });

  db.prepare(
    `INSERT INTO hr_transfer_requests (
      id, user_id, transfer_type, from_branch_id, to_branch_id, from_department, to_department,
      from_designation, to_designation, effective_date_iso, reason, status, requested_by_user_id,
      recommended_by_user_id, notes, created_at_iso, updated_at_iso, timeline_json, resubmitted_from_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
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
    notesWithWarnings,
    ts,
    ts,
    JSON.stringify(timeline),
    body?.resubmittedFromId || null
  );
  const created = db.prepare(`SELECT * FROM hr_transfer_requests WHERE id = ?`).get(id);
  if (created && status !== 'draft') {
    notifyHrTransferSubmitted(db, created, actor?.id || null);
  }
  return { ok: true, transfer: getHrTransferRequest(db, id), policyWarnings };
}

function persistTransferUpdate(db, id, { status, timeline, rejectionReason, approvedByUserId, ts }) {
  try {
    db.prepare(
      `UPDATE hr_transfer_requests SET status = ?, updated_at_iso = ?,
       approved_by_user_id = COALESCE(?, approved_by_user_id),
       rejection_reason = COALESCE(?, rejection_reason),
       timeline_json = ?
       WHERE id = ?`
    ).run(status, ts, approvedByUserId ?? null, rejectionReason ?? null, JSON.stringify(timeline), id);
  } catch {
    db.prepare(
      `UPDATE hr_transfer_requests SET status = ?, updated_at_iso = ?,
       approved_by_user_id = CASE WHEN ? IS NOT NULL THEN ? ELSE approved_by_user_id END
       WHERE id = ?`
    ).run(status, ts, approvedByUserId, approvedByUserId, id);
  }
}

export function patchHrTransferRequest(db, id, body, actor) {
  if (!hrTransferRequestsTableReady(db)) return { ok: false, error: 'Transfer module not initialised.' };
  const row = db.prepare(`SELECT * FROM hr_transfer_requests WHERE id = ?`).get(id);
  if (!row) return { ok: false, error: 'Transfer not found.' };

  const action = String(body?.action || '').trim();
  const ts = nowIso();
  let timeline = parseTimeline(row);
  const actorId = actor?.id || null;

  if (action === 'resubmit' && row.status === 'rejected') {
    const newBody = {
      ...body,
      userId: row.user_id,
      transferType: row.transfer_type,
      fromBranchId: row.from_branch_id,
      toBranchId: body?.toBranchId ?? row.to_branch_id,
      toDepartment: body?.toDepartment ?? row.to_department,
      toDesignation: body?.toDesignation ?? row.to_designation,
      effectiveDateIso: body?.effectiveDateIso ?? row.effective_date_iso,
      reason: body?.reason ?? row.reason,
      notes: body?.notes ?? row.notes,
      submit: true,
      resubmittedFromId: id,
    };
    return createHrTransferRequest(db, newBody, actor);
  }

  if (!action) {
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
  }

  if (action === 'complete' && row.status === 'approved') {
    return completeHrTransferRequest(db, id, actor);
  }

  let status = row.status;
  let rejectionReason = null;
  let approvedByUserId = null;

  if (action === 'submit' && row.status === 'draft') {
    status = initialStatusOnSubmit(row.transfer_type);
  } else if (action === 'branch_review' && row.status === 'submitted') {
    status = 'branch_review';
  } else if (action === 'hr_review' && ['submitted', 'branch_review'].includes(row.status)) {
    status = 'hr_review';
  } else if (action === 'gm_approval' && row.status === 'hr_review') {
    status = 'gm_approval';
  } else if (action === 'approve') {
    if (row.status === 'hr_review' && transferRequiresGmApproval(row.transfer_type)) {
      status = 'gm_approval';
    } else if (row.status === 'gm_approval') {
      if (!userCanGmApproveHr(actor)) {
        return { ok: false, error: 'GM HR approval is required for this transfer.' };
      }
      status = 'approved';
      approvedByUserId = actorId;
    } else if (row.status === 'hr_review') {
      status = 'approved';
      approvedByUserId = actorId;
    } else {
      return { ok: false, error: `Cannot approve transfer in status ${row.status}.` };
    }
  } else if (action === 'reject') {
    status = 'rejected';
    rejectionReason = String(body?.rejectionReason || body?.reason || '').trim() || 'Rejected';
    approvedByUserId = actorId;
  } else if (action === 'cancel' && !['completed', 'cancelled'].includes(row.status)) {
    status = 'cancelled';
  } else {
    return { ok: false, error: `Cannot ${action} transfer in status ${row.status}.` };
  }

  timeline = appendTimeline(timeline, {
    at: ts,
    action,
    actorUserId: actorId,
    status,
    note: rejectionReason || body?.note || null,
  });
  persistTransferUpdate(db, id, { status, timeline, rejectionReason, approvedByUserId, ts });
  const updated = db.prepare(`SELECT * FROM hr_transfer_requests WHERE id = ?`).get(id);
  if (updated) {
    if (action === 'reject') {
      notifyHrTransferOutcome(db, updated, 'rejected');
    } else if (status === 'hr_review' && row.status !== 'hr_review') {
      notifyHrTransferQueueHandoff(db, updated, 'hr_review', actorId);
    } else if (status === 'gm_approval') {
      notifyHrTransferQueueHandoff(db, updated, 'gm_approval', actorId);
    } else if (status === 'approved') {
      notifyHrTransferQueueHandoff(db, updated, 'approved', actorId);
      notifyHrTransferOutcome(db, updated, 'approved');
    }
  }
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

  let timeline = parseTimeline(row);
  timeline = appendTimeline(timeline, {
    at: ts,
    action: 'complete',
    actorUserId: actor?.id || null,
    status: 'completed',
  });
  try {
    db.prepare(
      `UPDATE hr_transfer_requests SET status = 'completed', completed_at_iso = ?, updated_at_iso = ?, timeline_json = ? WHERE id = ?`
    ).run(ts, ts, JSON.stringify(timeline), id);
  } catch {
    db.prepare(
      `UPDATE hr_transfer_requests SET status = 'completed', completed_at_iso = ?, updated_at_iso = ? WHERE id = ?`
    ).run(ts, ts, id);
  }

  const completed = db.prepare(`SELECT * FROM hr_transfer_requests WHERE id = ?`).get(id);
  if (completed) notifyHrTransferOutcome(db, completed, 'completed');

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
