import { canUseAllBranchesRollup, userCanApproveEditMutations, userHasPermission } from './auth.js';
import { DEFAULT_BRANCH_ID } from './branches.js';
import { appendAuditLog } from './controlOps.js';
import { listPendingEditApprovals } from './editApproval.js';
import {
  nextHrPerformanceReviewHumanId,
  nextInTransitLoadHumanId,
  nextMachineHumanId,
  nextMaintenanceEventHumanId,
  nextMaintenancePlanHumanId,
  nextMaintenanceWorkOrderHumanId,
  nextMaterialRequestHumanId,
  nextWorkItemDecisionHumanId,
  nextWorkItemHumanId,
} from './humanId.js';
import { hrListScope, listHrRequests } from './hrOps.js';
import { filingCompletenessForWorkItem } from './filingCompleteness.js';
import { listCoilRequests, listManagementItems, listPaymentRequests } from './readModel.js';

function nowIso() {
  return new Date().toISOString();
}

function datePlusHoursIso(hours) {
  const dt = new Date();
  dt.setHours(dt.getHours() + hours);
  return dt.toISOString();
}

function newSlaEventId() {
  return `WSLA-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isClosedStatus(status) {
  const s = String(status || '').trim().toLowerCase();
  return s === 'approved' || s === 'rejected' || s === 'closed' || s === 'completed' || s === 'cancelled';
}

function defaultDueAtIso(priority, requiresAttention) {
  if (!requiresAttention) return null;
  const p = String(priority || 'normal').trim().toLowerCase();
  if (p === 'critical') return datePlusHoursIso(4);
  if (p === 'urgent' || p === 'high') return datePlusHoursIso(24);
  return datePlusHoursIso(48);
}

function safeJsonParse(raw, fallback) {
  if (raw == null || raw === '') return fallback;
  try {
    const value = JSON.parse(String(raw));
    return value ?? fallback;
  } catch {
    return fallback;
  }
}

function normalizedDate(value) {
  const s = String(value || '').trim();
  return s || null;
}

export function workRegistryTablesReady(db) {
  try {
    return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_items'`).get());
  } catch {
    return false;
  }
}

export function officeKeyForUser(user) {
  const roleKey = String(user?.roleKey || '').trim().toLowerCase();
  switch (roleKey) {
    case 'sales_manager':
      return 'branch_manager';
    case 'sales_staff':
      return 'sales';
    case 'procurement_officer':
      return 'procurement';
    case 'operations_officer':
      return 'operations';
    case 'finance_manager':
      return 'finance';
    case 'cashier':
      return 'finance';
    case 'hr_manager':
    case 'hr_officer':
      return 'hr';
    case 'md':
      return 'executive';
    case 'ceo':
      return 'executive';
    case 'admin':
      return 'office_admin';
    default: {
      const dep = String(user?.department || '').trim().toLowerCase();
      if (dep === 'purchase') return 'procurement';
      if (dep === 'finance') return 'finance';
      if (dep === 'sales' || dep === 'customer') return 'sales';
      if (dep === 'inventory' || dep === 'production') return 'operations';
      if (dep === 'reports') return 'reports';
      if (dep === 'hr') return 'hr';
      return 'general';
    }
  }
}

/** Branch-manager / executive approval queues — excludes general sales officers who only have quotations.manage. */
export function canSeeManagementApprovalQueues(user) {
  if (!user) return false;
  if (userHasPermission(user, '*')) return true;
  const rk = String(user?.roleKey || '').trim().toLowerCase();
  if (rk === 'admin' || rk === 'ceo' || rk === 'md' || rk === 'sales_manager') return true;
  return userHasPermission(user, 'sales.manage');
}

/**
 * Default audience for persisted rows: queue owners, not entire departments.
 * @param {object} user
 * @param {{ responsible_office_key?: string; office_key?: string }} row
 */
function userMatchesWorkItemOfficeAudience(user, row) {
  const ro = String(row.responsible_office_key || row.office_key || '').trim().toLowerCase() || 'general';
  const rk = String(user?.roleKey || '').trim().toLowerCase();
  if (rk === 'admin' || userHasPermission(user, '*')) return true;
  if (ro === 'branch_manager' || ro === 'executive') return canSeeManagementApprovalQueues(user);
  if (ro === 'finance' || ro === 'treasury') {
    return userHasPermission(user, 'finance.approve') || userHasPermission(user, 'treasury.manage');
  }
  if (ro === 'procurement') {
    return userHasPermission(user, 'procurement.manage') || userHasPermission(user, 'purchase_orders.manage');
  }
  if (ro === 'operations') {
    return userHasPermission(user, 'operations.manage') || userHasPermission(user, 'production.manage');
  }
  if (ro === 'hr') {
    return (
      userHasPermission(user, 'hr.staff.manage') ||
      userHasPermission(user, 'hr.requests.hr_review') ||
      userHasPermission(user, 'hr.requests.final_approve')
    );
  }
  if (ro === 'sales') return userHasPermission(user, 'sales.manage');
  if (ro === 'office_admin') return userHasPermission(user, 'office.use');
  if (ro === 'general' || ro === 'reports') return userHasPermission(user, 'dashboard.view');
  return officeKeyForUser(user) === ro;
}

function hrLegacyRequestVisibleToUser(user, row) {
  const st = String(row.status || '');
  const rk = String(user?.roleKey || '').trim().toLowerCase();
  if (userHasPermission(user, '*') || rk === 'admin') return true;
  if (st === 'branch_manager_review') {
    return (
      userHasPermission(user, 'hr.branch.endorse_staff') ||
      rk === 'sales_manager' ||
      rk === 'md' ||
      rk === 'ceo'
    );
  }
  if (st === 'gm_hr_review') return userHasPermission(user, 'hr.requests.gm_approve');
  if (st === 'hr_review') {
    return userHasPermission(user, 'hr.requests.hr_review') || userHasPermission(user, 'hr.requests.final_approve');
  }
  return userHasPermission(user, 'hr.staff.manage') || userHasPermission(user, 'hr.requests.final_approve');
}

export const OFFICE_KEY_LABELS = {
  general: 'General',
  office_admin: 'Office administration',
  branch_manager: 'Branch manager',
  sales: 'Sales office',
  procurement: 'Procurement office',
  operations: 'Operations office',
  maintenance: 'Maintenance desk',
  finance: 'Finance office',
  hr: 'HR office',
  executive: 'Executive office',
  reports: 'Reports desk',
};

function documentTypeDefaultOfficeKey(documentType) {
  const type = String(documentType || '').trim().toLowerCase();
  if (
    type === 'quotation_clearance' ||
    type === 'production_gate' ||
    type === 'flagged_transaction' ||
    type === 'refund_request'
  ) {
    return 'branch_manager';
  }
  if (type === 'payment_request' || type === 'bank_recon_exceptions' || type === 'po_transport_payment') {
    return 'finance';
  }
  if (type === 'material_request' || type === 'in_transit_load') return 'procurement';
  if (type === 'machine_incident' || type === 'maintenance_work_order' || type === 'maintenance_plan') {
    return 'operations';
  }
  if (type.startsWith('hr_') || type === 'performance_review') return 'hr';
  if (type === 'correspondence' || type === 'report' || type === 'request') return 'office_admin';
  return 'general';
}

function workItemSearchBlob(item) {
  return [
    item.referenceNo,
    item.title,
    item.summary,
    item.documentType,
    item.documentClass,
    item.branchId,
    item.officeKey,
    item.responsibleOfficeKey,
    item.senderDisplayName,
    item.keyDecisionSummary,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function mapPersistedWorkItemRow(row, visibility = []) {
  const data = safeJsonParse(row.data_json, {});
  const dueAtIso = row.due_at_iso || '';
  const slaState =
    dueAtIso && !isClosedStatus(row.status) && dueAtIso < nowIso()
      ? 'overdue'
      : dueAtIso && !isClosedStatus(row.status)
        ? 'pending'
        : 'n/a';
  const filing =
    row._wf_ref !== undefined && row._wf_ref !== null
      ? {
          filingReference: String(row._wf_ref || ''),
          filingClass: String(row._wf_class || ''),
          retentionLabel: String(row._wf_retention || ''),
          archiveState: String(row._wf_archive || 'open'),
          printSummary: String(row._wf_print || ''),
        }
      : null;
  const fc = filingCompletenessForWorkItem(row.document_type, filing);
  return {
    id: row.id,
    referenceNo: row.reference_no,
    branchId: row.branch_id,
    officeKey: row.office_key,
    officeLabel: OFFICE_KEY_LABELS[row.office_key] || row.office_key || 'Office',
    documentClass: row.document_class,
    documentType: row.document_type,
    status: row.status,
    priority: row.priority,
    confidentiality: row.confidentiality,
    title: row.title,
    summary: row.summary || '',
    body: row.body || '',
    senderUserId: row.sender_user_id || '',
    senderDisplayName: row.sender_display_name || '',
    senderRoleKey: row.sender_role_key || '',
    senderOfficeKey: row.sender_office_key || '',
    senderBranchId: row.sender_branch_id || '',
    responsibleOfficeKey: row.responsible_office_key || row.office_key,
    responsibleUserId: row.responsible_user_id || '',
    dueAtIso,
    slaState,
    createdAtIso: row.created_at_iso,
    updatedAtIso: row.updated_at_iso,
    closedAtIso: row.closed_at_iso || '',
    archivedAtIso: row.archived_at_iso || '',
    requiresResponse: Boolean(row.requires_response),
    requiresApproval: Boolean(row.requires_approval),
    keyDecisionSummary: row.key_decision_summary || '',
    sourceKind: row.source_kind || '',
    sourceId: row.source_id || '',
    linkedThreadId: row.linked_thread_id || '',
    data,
    visibility,
    persisted: true,
    legacy: false,
    routePath: row.linked_thread_id ? '/' : data?.routePath || null,
    routeState: data?.routeState || (row.linked_thread_id ? { selectedThreadId: row.linked_thread_id } : null),
    filing,
    filingIncomplete: fc.filingIncomplete,
    filingIncompleteReason: fc.filingIncompleteReason,
  };
}

function loadWorkItemVisibility(db, workItemId) {
  if (!workRegistryTablesReady(db)) return [];
  return db
    .prepare(
      `SELECT visibility_kind AS visibilityKind, visibility_value AS visibilityValue, access_level AS accessLevel
       FROM work_item_visibility WHERE work_item_id = ?`
    )
    .all(workItemId);
}

export function userCanSeePersistedWorkItem(db, scope, user, row) {
  const uid = String(user?.id || '').trim();
  if (!uid || !row) return false;
  const roleKey = String(user?.roleKey || '').trim().toLowerCase();
  const officeKey = officeKeyForUser(user);
  const branchId = String(row.branch_id || '').trim() || DEFAULT_BRANCH_ID;
  const hqRollup = canUseAllBranchesRollup(user) && scope?.viewAll;
  if (hqRollup && (roleKey === 'admin' || roleKey === 'md' || roleKey === 'ceo')) return true;
  if (userHasPermission(user, '*')) return true;
  if (!scope?.viewAll && branchId !== String(scope?.branchId || DEFAULT_BRANCH_ID).trim()) return false;
  if (String(row.sender_user_id || '').trim() === uid) return true;
  if (String(row.responsible_user_id || '').trim() === uid) return true;

  const visibility = loadWorkItemVisibility(db, row.id);
  if (!visibility.length) {
    return userMatchesWorkItemOfficeAudience(user, row);
  }
  for (const entry of visibility) {
    if (entry.visibilityKind === 'user_id' && entry.visibilityValue === uid) return true;
    if (entry.visibilityKind === 'role_key' && entry.visibilityValue === roleKey) return true;
    if (entry.visibilityKind === 'office_key') {
      const ev = String(entry.visibilityValue || '').trim();
      const ro = String(row.responsible_office_key || row.office_key || '').trim();
      if (ev === ro || ev === officeKey) {
        if (userMatchesWorkItemOfficeAudience(user, row)) return true;
      }
    }
    if (
      entry.visibilityKind === 'branch_id' &&
      entry.visibilityValue === String(scope?.branchId || DEFAULT_BRANCH_ID).trim()
    ) {
      if (userMatchesWorkItemOfficeAudience(user, row)) return true;
    }
  }
  return false;
}

function insertVisibilityRows(db, workItemId, visibilityEntries = []) {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO work_item_visibility (work_item_id, visibility_kind, visibility_value, access_level)
     VALUES (?,?,?,?)`
  );
  for (const entry of visibilityEntries) {
    const visibilityKind = String(entry?.visibilityKind || '').trim();
    const visibilityValue = String(entry?.visibilityValue || '').trim();
    const accessLevel = String(entry?.accessLevel || 'view').trim() || 'view';
    if (!visibilityKind || !visibilityValue) continue;
    insert.run(workItemId, visibilityKind, visibilityValue, accessLevel);
  }
}

function insertLinkRows(db, workItemId, links = [], createdAtIso = nowIso()) {
  const insert = db.prepare(
    `INSERT OR IGNORE INTO work_item_links (work_item_id, entity_kind, entity_id, note, created_at_iso)
     VALUES (?,?,?,?,?)`
  );
  for (const link of links) {
    const entityKind = String(link?.entityKind || '').trim();
    const entityId = String(link?.entityId || '').trim();
    if (!entityKind || !entityId) continue;
    insert.run(workItemId, entityKind, entityId, String(link?.note || '').trim() || null, createdAtIso);
  }
}

function replaceVisibilityRows(db, workItemId, visibilityEntries = []) {
  db.prepare(`DELETE FROM work_item_visibility WHERE work_item_id = ?`).run(workItemId);
  insertVisibilityRows(db, workItemId, visibilityEntries);
}

function replaceLinkRows(db, workItemId, links = [], createdAtIso = nowIso()) {
  db.prepare(`DELETE FROM work_item_links WHERE work_item_id = ?`).run(workItemId);
  insertLinkRows(db, workItemId, links, createdAtIso);
}

function defaultVisibilityEntries(payload) {
  const entries = [];
  const senderUserId = String(payload?.senderUserId || '').trim();
  const responsibleUserId = String(payload?.responsibleUserId || '').trim();
  const senderRoleKey = String(payload?.senderRoleKey || '').trim().toLowerCase();
  const confidentiality = String(payload?.confidentiality || 'internal').trim().toLowerCase() || 'internal';
  const responsibleOfficeKey =
    String(payload?.responsibleOfficeKey || payload?.officeKey || '').trim() ||
    documentTypeDefaultOfficeKey(payload?.documentType);
  const branchId = String(payload?.branchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
  if (senderUserId) entries.push({ visibilityKind: 'user_id', visibilityValue: senderUserId });
  if (responsibleUserId) entries.push({ visibilityKind: 'user_id', visibilityValue: responsibleUserId });
  if (responsibleOfficeKey) entries.push({ visibilityKind: 'office_key', visibilityValue: responsibleOfficeKey });
  if (confidentiality === 'internal') {
    if (senderRoleKey) entries.push({ visibilityKind: 'role_key', visibilityValue: senderRoleKey });
    // Do not add branch_id here: it made every user in the branch see the item via visibility OR rules.
  } else if (confidentiality === 'restricted') {
    if (branchId) entries.push({ visibilityKind: 'branch_id', visibilityValue: branchId, accessLevel: 'review' });
  }
  return entries;
}

export function createWorkItem(db, payload) {
  if (!workRegistryTablesReady(db)) return { ok: false, error: 'Work registry is not available.' };
  const branchId = String(payload?.branchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
  const id = String(payload?.id || '').trim() || nextWorkItemHumanId(db, branchId);
  const referenceNo = String(payload?.referenceNo || '').trim() || id;
  const title = String(payload?.title || '').trim();
  if (!title) return { ok: false, error: 'Work item title is required.' };
  const documentClass = String(payload?.documentClass || 'request').trim() || 'request';
  const documentType = String(payload?.documentType || documentClass).trim() || documentClass;
  const officeKey =
    String(payload?.officeKey || '').trim() || documentTypeDefaultOfficeKey(documentType) || 'general';
  const responsibleOfficeKey =
    String(payload?.responsibleOfficeKey || '').trim() || officeKey || documentTypeDefaultOfficeKey(documentType);
  const now = nowIso();
  const requiresResponse = Boolean(payload?.requiresResponse);
  const requiresApproval = Boolean(payload?.requiresApproval);
  const dueAtIso = normalizedDate(payload?.dueAtIso) || defaultDueAtIso(payload?.priority, requiresResponse || requiresApproval);
  const visibilityEntries = [
    ...defaultVisibilityEntries({
      branchId,
      senderUserId: payload?.senderUserId,
      responsibleUserId: payload?.responsibleUserId,
      senderRoleKey: payload?.senderRoleKey,
      responsibleOfficeKey,
      officeKey,
      confidentiality: payload?.confidentiality,
    }),
    ...(Array.isArray(payload?.visibilityEntries) ? payload.visibilityEntries : []),
  ];
  db.transaction(() => {
    db.prepare(
      `INSERT INTO work_items (
        id, reference_no, branch_id, office_key, document_class, document_type, status, priority, confidentiality,
        title, summary, body, sender_user_id, sender_display_name, sender_role_key, sender_office_key,
        sender_branch_id, responsible_office_key, responsible_user_id, due_at_iso, created_at_iso, updated_at_iso,
        closed_at_iso, archived_at_iso, requires_response, requires_approval, key_decision_summary, source_kind,
        source_id, linked_thread_id, data_json
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      id,
      referenceNo,
      branchId,
      officeKey,
      documentClass,
      documentType,
      String(payload?.status || 'open').trim() || 'open',
      String(payload?.priority || 'normal').trim() || 'normal',
      String(payload?.confidentiality || 'internal').trim() || 'internal',
      title,
      String(payload?.summary || '').trim() || null,
      String(payload?.body || '').trim() || null,
      String(payload?.senderUserId || '').trim() || null,
      String(payload?.senderDisplayName || '').trim() || null,
      String(payload?.senderRoleKey || '').trim() || null,
      String(payload?.senderOfficeKey || '').trim() || null,
      String(payload?.senderBranchId || branchId).trim() || branchId,
      responsibleOfficeKey,
      String(payload?.responsibleUserId || '').trim() || null,
      dueAtIso,
      now,
      now,
      normalizedDate(payload?.closedAtIso),
      normalizedDate(payload?.archivedAtIso),
      requiresResponse ? 1 : 0,
      requiresApproval ? 1 : 0,
      String(payload?.keyDecisionSummary || '').trim() || null,
      String(payload?.sourceKind || '').trim() || null,
      String(payload?.sourceId || '').trim() || null,
      String(payload?.linkedThreadId || '').trim() || null,
      payload?.data != null ? JSON.stringify(payload.data) : null
    );
    insertVisibilityRows(db, id, visibilityEntries);
    insertLinkRows(db, id, payload?.links, now);
    if (dueAtIso && (requiresResponse || requiresApproval)) {
      db.prepare(
        `INSERT INTO work_item_sla_events (
          id, work_item_id, event_kind, due_at_iso, occurred_at_iso, state, note, created_at_iso
        ) VALUES (?,?,?,?,?,?,?,?)`
      ).run(
        newSlaEventId(),
        id,
        requiresApproval ? 'approval_due' : 'response_due',
        dueAtIso,
        null,
        'pending',
        null,
        now
      );
    }
    if (payload?.filing) {
      db.prepare(
        `INSERT OR REPLACE INTO work_item_filing (
          work_item_id, filing_reference, filing_class, retention_label, archive_state, print_summary, updated_at_iso
        ) VALUES (?,?,?,?,?,?,?)`
      ).run(
        id,
        String(payload.filing?.filingReference || '').trim() || null,
        String(payload.filing?.filingClass || '').trim() || null,
        String(payload.filing?.retentionLabel || '').trim() || null,
        String(payload.filing?.archiveState || 'open').trim() || 'open',
        String(payload.filing?.printSummary || '').trim() || null,
        now
      );
    }
  })();
  if (!payload?.suppressAudit) {
    appendAuditLog(db, {
      actor: payload?.actor,
      action: 'work_item.create',
      entityKind: 'work_item',
      entityId: id,
      note: title,
      details: { documentClass, documentType, officeKey: responsibleOfficeKey, referenceNo },
    });
  }
  return getPersistedWorkItem(db, id);
}

const WORK_ITEM_FILING_JOIN_SQL = `
  SELECT wi.*,
    wf.filing_reference AS _wf_ref,
    wf.filing_class AS _wf_class,
    wf.retention_label AS _wf_retention,
    wf.archive_state AS _wf_archive,
    wf.print_summary AS _wf_print
  FROM work_items wi
  LEFT JOIN work_item_filing wf ON wf.work_item_id = wi.id`;

export function getPersistedWorkItem(db, workItemId) {
  if (!workRegistryTablesReady(db)) return { ok: false, error: 'Work registry is not available.' };
  const row = db
    .prepare(`${WORK_ITEM_FILING_JOIN_SQL} WHERE wi.id = ?`)
    .get(String(workItemId || '').trim());
  if (!row) return { ok: false, error: 'Work item not found.' };
  return { ok: true, item: mapPersistedWorkItemRow(row, loadWorkItemVisibility(db, row.id)) };
}

export function findPersistedWorkItemBySource(db, sourceKind, sourceId) {
  if (!workRegistryTablesReady(db)) return null;
  const sk = String(sourceKind || '').trim();
  const sid = String(sourceId || '').trim();
  if (!sk || !sid) return null;
  const row = db
    .prepare(
      `${WORK_ITEM_FILING_JOIN_SQL} WHERE wi.source_kind = ? AND wi.source_id = ? ORDER BY wi.updated_at_iso DESC LIMIT 1`
    )
    .get(sk, sid);
  return row ? mapPersistedWorkItemRow(row, loadWorkItemVisibility(db, row.id)) : null;
}

export function upsertWorkItemBySource(db, payload) {
  if (!workRegistryTablesReady(db)) return { ok: false, error: 'Work registry is not available.' };
  const sourceKind = String(payload?.sourceKind || '').trim();
  const sourceId = String(payload?.sourceId || '').trim();
  if (!sourceKind || !sourceId) return createWorkItem(db, payload);
  const existing = db
    .prepare(`SELECT * FROM work_items WHERE source_kind = ? AND source_id = ? ORDER BY updated_at_iso DESC LIMIT 1`)
    .get(sourceKind, sourceId);
  if (!existing) return createWorkItem(db, payload);

  const branchId = String(payload?.branchId || existing.branch_id || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
  const title = String(payload?.title || existing.title || '').trim();
  if (!title) return { ok: false, error: 'Work item title is required.' };
  const documentClass = String(payload?.documentClass || existing.document_class || 'request').trim() || 'request';
  const documentType = String(payload?.documentType || existing.document_type || documentClass).trim() || documentClass;
  const officeKey =
    String(payload?.officeKey || existing.office_key || '').trim() || documentTypeDefaultOfficeKey(documentType) || 'general';
  const responsibleOfficeKey =
    String(payload?.responsibleOfficeKey || existing.responsible_office_key || officeKey).trim() ||
    officeKey ||
    documentTypeDefaultOfficeKey(documentType);
  const updatedAtIso = String(payload?.updatedAtIso || '').trim() || nowIso();
  const visibilityEntries = [
    ...defaultVisibilityEntries({
      branchId,
      senderUserId: payload?.senderUserId ?? existing.sender_user_id,
      responsibleUserId: payload?.responsibleUserId ?? existing.responsible_user_id,
      senderRoleKey: payload?.senderRoleKey ?? existing.sender_role_key,
      responsibleOfficeKey,
      officeKey,
      confidentiality: payload?.confidentiality ?? existing.confidentiality,
    }),
    ...(Array.isArray(payload?.visibilityEntries) ? payload.visibilityEntries : []),
  ];
  const links = Array.isArray(payload?.links) ? payload.links : undefined;
  db.transaction(() => {
    db.prepare(
      `UPDATE work_items SET
        branch_id = ?, office_key = ?, document_class = ?, document_type = ?, status = ?, priority = ?, confidentiality = ?,
        title = ?, summary = ?, body = ?, sender_user_id = ?, sender_display_name = ?, sender_role_key = ?, sender_office_key = ?,
        sender_branch_id = ?, responsible_office_key = ?, responsible_user_id = ?, due_at_iso = ?, updated_at_iso = ?,
        closed_at_iso = ?, archived_at_iso = ?, requires_response = ?, requires_approval = ?, key_decision_summary = ?,
        linked_thread_id = ?, data_json = ?
      WHERE id = ?`
    ).run(
      branchId,
      officeKey,
      documentClass,
      documentType,
      String(payload?.status || existing.status || 'open').trim() || 'open',
      String(payload?.priority || existing.priority || 'normal').trim() || 'normal',
      String(payload?.confidentiality || existing.confidentiality || 'internal').trim() || 'internal',
      title,
      String(payload?.summary ?? existing.summary ?? '').trim() || null,
      String(payload?.body ?? existing.body ?? '').trim() || null,
      String(payload?.senderUserId ?? existing.sender_user_id ?? '').trim() || null,
      String(payload?.senderDisplayName ?? existing.sender_display_name ?? '').trim() || null,
      String(payload?.senderRoleKey ?? existing.sender_role_key ?? '').trim() || null,
      String(payload?.senderOfficeKey ?? existing.sender_office_key ?? '').trim() || null,
      String(payload?.senderBranchId ?? existing.sender_branch_id ?? branchId).trim() || branchId,
      responsibleOfficeKey,
      String(payload?.responsibleUserId ?? existing.responsible_user_id ?? '').trim() || null,
      normalizedDate(payload?.dueAtIso ?? existing.due_at_iso),
      updatedAtIso,
      normalizedDate(payload?.closedAtIso ?? existing.closed_at_iso),
      normalizedDate(payload?.archivedAtIso ?? existing.archived_at_iso),
      payload?.requiresResponse !== undefined ? (payload.requiresResponse ? 1 : 0) : Number(existing.requires_response) ? 1 : 0,
      payload?.requiresApproval !== undefined ? (payload.requiresApproval ? 1 : 0) : Number(existing.requires_approval) ? 1 : 0,
      String(payload?.keyDecisionSummary ?? existing.key_decision_summary ?? '').trim() || null,
      String(payload?.linkedThreadId ?? existing.linked_thread_id ?? '').trim() || null,
      payload?.data !== undefined
        ? payload.data != null
          ? JSON.stringify(payload.data)
          : null
        : existing.data_json,
      existing.id
    );
    if (payload?.visibilityEntries !== undefined || payload?.senderUserId !== undefined || payload?.responsibleOfficeKey !== undefined) {
      replaceVisibilityRows(db, existing.id, visibilityEntries);
    }
    if (links !== undefined) {
      replaceLinkRows(db, existing.id, links, updatedAtIso);
    }
    if (payload?.filing) {
      db.prepare(
        `INSERT OR REPLACE INTO work_item_filing (
          work_item_id, filing_reference, filing_class, retention_label, archive_state, print_summary, updated_at_iso
        ) VALUES (?,?,?,?,?,?,?)`
      ).run(
        existing.id,
        String(payload.filing?.filingReference || '').trim() || null,
        String(payload.filing?.filingClass || '').trim() || null,
        String(payload.filing?.retentionLabel || '').trim() || null,
        String(payload.filing?.archiveState || 'open').trim() || 'open',
        String(payload.filing?.printSummary || '').trim() || null,
        updatedAtIso
      );
    }
  })();
  if (!payload?.suppressAudit) {
    appendAuditLog(db, {
      actor: payload?.actor,
      action: 'work_item.sync',
      entityKind: 'work_item',
      entityId: existing.id,
      note: title,
      details: { sourceKind, sourceId, documentType, status: String(payload?.status || existing.status || 'open') },
    });
  }
  return getPersistedWorkItem(db, existing.id);
}

export function appendWorkItemDecision(db, payload) {
  if (!workRegistryTablesReady(db)) return { ok: false, error: 'Work registry is not available.' };
  const workItemId = String(payload?.workItemId || '').trim();
  const row = db.prepare(`SELECT * FROM work_items WHERE id = ?`).get(workItemId);
  if (!row) return { ok: false, error: 'Work item not found.' };
  const decisionKey = String(payload?.decisionKey || 'review').trim() || 'review';
  const outcomeStatus = String(payload?.outcomeStatus || '').trim();
  if (!outcomeStatus) return { ok: false, error: 'Decision outcome is required.' };
  const note = String(payload?.note || '').trim();
  const actedAtIso = String(payload?.actedAtIso || '').trim() || nowIso();
  const actor = payload?.actor || null;
  const actorOfficeKey = String(payload?.actorOfficeKey || officeKeyForUser(actor)).trim() || 'general';
  const nextStatus = String(payload?.nextStatus || outcomeStatus).trim() || outcomeStatus;
  const summary =
    String(payload?.keyDecisionSummary || '').trim() ||
    note ||
    `${decisionKey}: ${outcomeStatus}`.replace(/_/g, ' ');
  const id = nextWorkItemDecisionHumanId(db);
  db.transaction(() => {
    db.prepare(
      `INSERT INTO work_item_decisions (
        id, work_item_id, decision_key, outcome_status, note, actor_user_id, actor_display_name,
        actor_role_key, actor_office_key, actor_branch_id, acted_at_iso, data_json
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      id,
      workItemId,
      decisionKey,
      outcomeStatus,
      note || null,
      String(actor?.id || '').trim() || null,
      String(actor?.displayName || actor?.username || '').trim() || null,
      String(actor?.roleKey || '').trim() || null,
      actorOfficeKey,
      String(payload?.actorBranchId || row.branch_id || '').trim() || row.branch_id,
      actedAtIso,
      payload?.data != null ? JSON.stringify(payload.data) : null
    );
    db.prepare(
      `UPDATE work_items
       SET status = ?, updated_at_iso = ?, key_decision_summary = ?,
           closed_at_iso = CASE WHEN ? IN ('closed','approved','rejected','cancelled','completed') THEN COALESCE(closed_at_iso, ?) ELSE closed_at_iso END
       WHERE id = ?`
    ).run(nextStatus, actedAtIso, summary, nextStatus, actedAtIso, workItemId);
    if (isClosedStatus(nextStatus)) {
      db.prepare(
        `UPDATE work_item_sla_events
         SET occurred_at_iso = ?, state = 'satisfied', note = COALESCE(note, ?)
         WHERE work_item_id = ? AND state = 'pending'`
      ).run(actedAtIso, summary, workItemId);
    }
  })();
  appendAuditLog(db, {
    actor,
    action: 'work_item.decision',
    entityKind: 'work_item',
    entityId: workItemId,
    note: note || `${decisionKey}: ${outcomeStatus}`,
    details: { decisionId: id, decisionKey, outcomeStatus },
  });
  return getPersistedWorkItem(db, workItemId);
}

export function linkWorkItemToOfficeThread(db, workItemId, threadId) {
  if (!workRegistryTablesReady(db)) return { ok: false, error: 'Work registry is not available.' };
  const wid = String(workItemId || '').trim();
  const tid = String(threadId || '').trim();
  if (!wid || !tid) return { ok: false, error: 'workItemId and threadId are required.' };
  db.transaction(() => {
    db.prepare(`UPDATE work_items SET linked_thread_id = ?, updated_at_iso = ? WHERE id = ?`).run(tid, nowIso(), wid);
    db.prepare(`UPDATE office_threads SET related_work_item_id = ? WHERE id = ?`).run(wid, tid);
  })();
  return { ok: true };
}

export function ensureWorkItemForOfficeThread(db, threadId, actor = null) {
  if (!workRegistryTablesReady(db)) return { ok: false, error: 'Work registry is not available.' };
  const tid = String(threadId || '').trim();
  if (!tid) return { ok: false, error: 'threadId is required.' };
  const row = db.prepare(`SELECT * FROM office_threads WHERE id = ?`).get(tid);
  if (!row) return { ok: false, error: 'Thread not found.' };
  const existingId = String(row.related_work_item_id || '').trim();
  if (existingId) return getPersistedWorkItem(db, existingId);
  const toUserIds = safeJsonParse(row.to_user_ids_json, []).filter(Boolean);
  const ccUserIds = safeJsonParse(row.cc_user_ids_json, []).filter(Boolean);
  const visibilityEntries = [
    { visibilityKind: 'user_id', visibilityValue: String(row.created_by_user_id || '').trim() },
    ...toUserIds.map((userId) => ({ visibilityKind: 'user_id', visibilityValue: String(userId || '').trim() })),
    ...ccUserIds.map((userId) => ({ visibilityKind: 'user_id', visibilityValue: String(userId || '').trim() })),
    { visibilityKind: 'branch_id', visibilityValue: String(row.branch_id || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID },
  ];
  const payload = safeJsonParse(row.payload_json, {});
  const createResult = createWorkItem(db, {
    actor,
    branchId: String(row.branch_id || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID,
    officeKey: String(row.office_key || '').trim() || 'office_admin',
    responsibleOfficeKey: String(row.office_key || '').trim() || 'office_admin',
    documentClass: String(row.document_class || 'correspondence').trim() || 'correspondence',
    documentType: String(row.kind || 'memo').trim() || 'memo',
    confidentiality: String(payload?.confidentiality || 'internal').trim() || 'internal',
    status: String(row.status || 'open').trim() || 'open',
    title: String(row.subject || '').trim() || tid,
    summary: String(row.body || '').trim() || '',
    body: String(row.body || '').trim() || '',
    senderUserId: String(row.created_by_user_id || '').trim(),
    senderDisplayName: payload?.senderDisplayName || '',
    senderRoleKey: payload?.senderRoleKey || '',
    senderOfficeKey: payload?.senderOfficeKey || '',
    senderBranchId: String(row.branch_id || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID,
    linkedThreadId: tid,
    sourceKind: 'office_thread',
    sourceId: tid,
    requiresResponse: true,
    visibilityEntries,
    links: row.related_payment_request_id
      ? [{ entityKind: 'payment_request', entityId: String(row.related_payment_request_id).trim() }]
      : [],
    data: {
      officeThreadId: tid,
      memoDateIso: payload?.memoDateIso || null,
      attachmentsCount: Array.isArray(payload?.attachments) ? payload.attachments.length : 0,
    },
  });
  if (!createResult.ok) return createResult;
  linkWorkItemToOfficeThread(db, createResult.item.id, tid);
  return createResult;
}

export function ensureWorkItemsForVisibleOfficeThreads(db, scope, user) {
  if (!workRegistryTablesReady(db)) return [];
  let sql = `SELECT id FROM office_threads WHERE 1=1`;
  const args = [];
  if (!scope?.viewAll) {
    sql += ` AND branch_id = ?`;
    args.push(String(scope?.branchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID);
  }
  sql += ` ORDER BY updated_at_iso DESC LIMIT 200`;
  const out = [];
  for (const row of db.prepare(sql).all(...args)) {
    const r = ensureWorkItemForOfficeThread(db, row.id, user);
    if (r.ok && r.item) out.push(r.item);
  }
  return out;
}

function upsertLegacyBaseAsWorkItem(db, base, actor = null, { suppressAudit = true } = {}) {
  return upsertWorkItemBySource(db, {
    actor,
    suppressAudit,
    branchId: base.branchId,
    officeKey: base.officeKey,
    responsibleOfficeKey: base.responsibleOfficeKey || base.officeKey,
    documentClass: base.documentClass,
    documentType: base.documentType,
    status: base.status,
    priority: base.priority,
    confidentiality: base.confidentiality,
    title: base.title,
    summary: base.summary,
    body: base.body,
    senderUserId: base.senderUserId,
    senderDisplayName: base.senderDisplayName,
    senderRoleKey: base.senderRoleKey,
    senderOfficeKey: base.senderOfficeKey,
    senderBranchId: base.senderBranchId,
    responsibleUserId: base.responsibleUserId,
    dueAtIso: base.dueAtIso,
    requiresResponse: base.requiresResponse,
    requiresApproval: base.requiresApproval,
    keyDecisionSummary: base.keyDecisionSummary,
    sourceKind: base.sourceKind,
    sourceId: base.sourceId,
    linkedThreadId: base.linkedThreadId,
    visibilityEntries: base.visibility,
    data: {
      ...(base.data || {}),
      routePath: base.routePath || null,
      routeState: base.routeState || null,
    },
  });
}

export function syncDerivedWorkItems(db, scope, user) {
  if (!workRegistryTablesReady(db) || !user) return [];
  const seeds = [
    ...listLegacyManagementWorkItems(db, scope, user),
    ...listLegacyEditApprovalWorkItems(db, user),
    ...listLegacyCoilRequestWorkItems(db, scope, user),
    ...listLegacyHrRequestWorkItems(db, scope, user),
    ...listLegacyHrDisciplineCaseWorkItems(db, scope, user),
    ...listLegacyHrPerformanceReviewWorkItems(db, scope, user),
  ];
  const out = [];
  for (const base of seeds) {
    const r = upsertLegacyBaseAsWorkItem(db, base, null, { suppressAudit: true });
    if (r?.ok && r.item) out.push(r.item);
  }
  return out;
}

function legacyItemId(prefix, id) {
  return `LEGACY-${prefix}-${String(id || '').trim()}`;
}

function legacyWorkItemBase(base) {
  return {
    id: base.id,
    referenceNo: base.referenceNo || base.id,
    branchId: base.branchId || DEFAULT_BRANCH_ID,
    officeKey: base.officeKey || 'general',
    officeLabel: OFFICE_KEY_LABELS[base.officeKey] || base.officeKey || 'Office',
    documentClass: base.documentClass || 'request',
    documentType: base.documentType || 'legacy',
    status: base.status || 'open',
    priority: base.priority || 'normal',
    confidentiality: base.confidentiality || 'internal',
    title: base.title || base.referenceNo || base.id,
    summary: base.summary || '',
    body: base.body || '',
    senderUserId: base.senderUserId || '',
    senderDisplayName: base.senderDisplayName || '',
    senderRoleKey: base.senderRoleKey || '',
    senderOfficeKey: base.senderOfficeKey || '',
    senderBranchId: base.senderBranchId || base.branchId || DEFAULT_BRANCH_ID,
    responsibleOfficeKey: base.responsibleOfficeKey || base.officeKey || 'general',
    responsibleUserId: base.responsibleUserId || '',
    dueAtIso: base.dueAtIso || '',
    createdAtIso: base.createdAtIso || '',
    updatedAtIso: base.updatedAtIso || base.createdAtIso || '',
    closedAtIso: '',
    archivedAtIso: '',
    requiresResponse: Boolean(base.requiresResponse),
    requiresApproval: base.requiresApproval !== false,
    keyDecisionSummary: base.keyDecisionSummary || '',
    sourceKind: base.sourceKind || '',
    sourceId: base.sourceId || '',
    linkedThreadId: '',
    data: base.data || {},
    visibility: base.visibility || [],
    persisted: false,
    legacy: true,
    routePath: base.routePath || null,
    routeState: base.routeState || null,
    filing: null,
    filingIncomplete: false,
    filingIncompleteReason: null,
  };
}

function persistedSourceKey(item) {
  const sourceKind = String(item?.sourceKind || '').trim();
  const sourceId = String(item?.sourceId || '').trim();
  if (!sourceKind || !sourceId) return '';
  return `${sourceKind}:${sourceId}`;
}

function collectPersistedSourceKeys(items) {
  const out = new Set();
  for (const item of items) {
    const key = persistedSourceKey(item);
    if (key) out.add(key);
  }
  return out;
}

function listLegacyManagementWorkItems(db, scope, user) {
  const canMgmtQueues = canSeeManagementApprovalQueues(user);
  const canRefund = userHasPermission(user, 'refunds.approve') || userHasPermission(user, 'finance.approve');
  const canFinanceApprove = userHasPermission(user, 'finance.approve');
  const branchScope = scope?.viewAll && canUseAllBranchesRollup(user) ? 'ALL' : scope?.branchId || DEFAULT_BRANCH_ID;
  const queues = listManagementItems(db, branchScope);
  const out = [];
  if (canMgmtQueues) {
    for (const row of queues.pendingClearance || []) {
      out.push(
        legacyWorkItemBase({
          id: legacyItemId('quotation-clearance', row.id),
          referenceNo: row.id,
          branchId: scope?.branchId || DEFAULT_BRANCH_ID,
          officeKey: 'branch_manager',
          documentClass: 'approval',
          documentType: 'quotation_clearance',
          status: 'pending_review',
          title: `Quotation clearance ${row.id}`,
          summary: `${row.customer_name || 'Customer'} · paid ${row.paid_ngn || 0} of ${row.total_ngn || 0}`,
          createdAtIso: row.date_iso || '',
          sourceKind: 'quotation_clearance',
          sourceId: row.id,
          routePath: '/manager',
        })
      );
    }
    for (const row of queues.productionOverrides || []) {
      out.push(
        legacyWorkItemBase({
          id: legacyItemId('production-gate', row.id),
          referenceNo: row.quotation_ref || row.id,
          branchId: row.branch_id || scope?.branchId || DEFAULT_BRANCH_ID,
          officeKey: 'branch_manager',
          documentClass: 'approval',
          documentType: 'production_gate',
          status: 'pending_review',
          title: `Production gate ${row.quotation_ref || row.id}`,
          summary: `${row.customer_name || 'Customer'} · ${row.total_meters || 0} m draft under payment threshold`,
          sourceKind: 'production_gate',
          sourceId: row.quotation_ref || row.id,
          routePath: '/manager',
        })
      );
    }
    for (const row of queues.flagged || []) {
      out.push(
        legacyWorkItemBase({
          id: legacyItemId('flagged-transaction', row.id),
          referenceNo: row.id,
          branchId: scope?.branchId || DEFAULT_BRANCH_ID,
          officeKey: 'branch_manager',
          documentClass: 'report',
          documentType: 'flagged_transaction',
          status: 'flagged',
          priority: 'high',
          title: `Flagged quotation ${row.id}`,
          summary: row.manager_flag_reason || 'Manager flag raised for audit review.',
          createdAtIso: row.manager_flagged_at_iso || '',
          sourceKind: 'flagged_transaction',
          sourceId: row.id,
          routePath: '/manager',
        })
      );
    }
    for (const row of queues.pendingConversionReviews || []) {
      out.push(
        legacyWorkItemBase({
          id: legacyItemId('conversion-review', row.job_id),
          referenceNo: row.job_id,
          branchId: scope?.branchId || DEFAULT_BRANCH_ID,
          officeKey: 'branch_manager',
          documentClass: 'approval',
          documentType: 'conversion_review',
          status: 'pending_review',
          title: `Conversion review ${row.job_id}`,
          summary: `${row.customer_name || ''} · ${row.product_name || ''} · ${row.conversion_alert_state || 'Pending'}`.trim(),
          createdAtIso: row.completed_at_iso || '',
          sourceKind: 'conversion_review',
          sourceId: row.job_id,
          routePath: '/manager',
          data: { quotationRef: row.quotation_ref || '', productionJobId: row.job_id },
        })
      );
    }
  }
  if (canRefund) {
    for (const row of queues.pendingRefunds || []) {
      out.push(
        legacyWorkItemBase({
          id: legacyItemId('refund-request', row.refund_id),
          referenceNo: row.refund_id,
          branchId: scope?.branchId || DEFAULT_BRANCH_ID,
          officeKey: 'branch_manager',
          documentClass: 'approval',
          documentType: 'refund_request',
          status: 'pending_review',
          title: `Refund request ${row.refund_id}`,
          summary: `${row.customer_name || ''} · ${row.reason_category || ''}`.trim(),
          createdAtIso: row.requested_at_iso || '',
          sourceKind: 'refund_request',
          sourceId: row.refund_id,
          routePath: '/manager',
          data: { quotationRef: row.quotation_ref || '' },
        })
      );
    }
  }
  if (canFinanceApprove) {
    const requests = listPaymentRequests(db, branchScope);
    for (const row of requests.filter((item) => String(item.approvalStatus || '').toLowerCase() === 'pending')) {
      out.push(
        legacyWorkItemBase({
          id: legacyItemId('payment-request', row.requestID),
          referenceNo: row.requestID,
          branchId: row.branchId || scope?.branchId || DEFAULT_BRANCH_ID,
          officeKey: 'finance',
          documentClass: 'approval',
          documentType: 'payment_request',
          status: 'pending_review',
          title: `Payment request ${row.requestID}`,
          summary: `${row.expenseCategory || ''} · ${row.description || ''}`.trim(),
          createdAtIso: row.requestDate || '',
          sourceKind: 'payment_request',
          sourceId: row.requestID,
          routePath: '/accounts',
          data: { amountRequestedNgn: row.amountRequestedNgn || 0 },
        })
      );
    }
  }
  return out;
}

function listLegacyEditApprovalWorkItems(db, user) {
  if (!userCanApproveEditMutations(user)) return [];
  return listPendingEditApprovals(db).map((row) =>
    legacyWorkItemBase({
      id: legacyItemId('edit-approval', row.id),
      referenceNo: row.id,
      branchId: row.branchId || DEFAULT_BRANCH_ID,
      officeKey: 'branch_manager',
      documentClass: 'approval',
      documentType: 'edit_approval',
      status: 'pending_review',
      title: `Edit approval ${row.id}`,
      summary: `${row.entityKind} · ${row.entityId}`,
      createdAtIso: row.requestedAtISO || '',
      senderUserId: row.requestedByUserId || '',
      senderDisplayName: row.requestedByDisplay || '',
      sourceKind: 'edit_approval',
      sourceId: row.id,
      routePath: '/manager',
      routeState: { inbox: 'edit_approvals' },
    })
  );
}

function listLegacyCoilRequestWorkItems(db, scope, user) {
  const canSee =
    userHasPermission(user, 'operations.manage') ||
    userHasPermission(user, 'production.manage') ||
    userHasPermission(user, 'purchase_orders.manage') ||
    userHasPermission(user, 'procurement.manage');
  if (!canSee) return [];
  return listCoilRequests(db).map((row) =>
    legacyWorkItemBase({
      id: legacyItemId('coil-request', row.id),
      referenceNo: row.id,
      branchId: row.branchId || scope?.branchId || DEFAULT_BRANCH_ID,
      officeKey: 'procurement',
      documentClass: 'request',
      documentType: 'material_request',
      status: String(row.status || 'pending').toLowerCase(),
      title: `Material request ${row.id}`,
      summary: `${row.gauge || '—'} mm · ${row.colour || '—'} · ${row.materialType || '—'}${row.requestedKg ? ` · ${row.requestedKg} kg` : ''}`,
      createdAtIso: row.createdAtISO || '',
      sourceKind: 'coil_request',
      sourceId: row.id,
      routePath: '/operations',
    })
  );
}

function listLegacyHrRequestWorkItems(db, scope, user) {
  const hrScope = hrListScope({
    user,
    workspaceBranchId: scope?.branchId || DEFAULT_BRANCH_ID,
    workspaceViewAll: scope?.viewAll,
  });
  const canSee =
    userHasPermission(user, 'hr.requests.hr_review') ||
    userHasPermission(user, 'hr.requests.gm_approve') ||
    userHasPermission(user, 'hr.requests.final_approve') ||
    userHasPermission(user, 'hr.branch.endorse_staff') ||
    userHasPermission(user, 'hr.staff.manage') ||
    userHasPermission(user, '*');
  if (!canSee) return [];
  return listHrRequests(db, hrScope, {})
    .filter((row) => row.status !== 'draft')
    .filter((row) => hrLegacyRequestVisibleToUser(user, row))
    .map((row) => {
      const st = String(row.status || '').trim().toLowerCase();
      const terminal = st === 'approved' || st === 'rejected' || st === 'cancelled';
      return legacyWorkItemBase({
        id: legacyItemId('hr-request', row.id),
        referenceNo: row.id,
        branchId: row.branchId || DEFAULT_BRANCH_ID,
        officeKey:
          row.status === 'branch_manager_review'
            ? 'branch_manager'
            : row.status === 'approved' || row.status === 'rejected'
              ? 'hr'
              : 'hr',
        documentClass: 'request',
        documentType: `hr_${row.kind}`,
        status: row.status,
        title: row.title,
        summary: `${row.staffDisplayName || row.staffUsername || ''} · ${row.kind}`.trim(),
        createdAtIso: row.createdAtIso || '',
        updatedAtIso: row.gmHrReviewedAtIso || row.managerReviewedAtIso || row.hrReviewedAtIso || row.createdAtIso || '',
        requiresApproval: !terminal,
        requiresResponse: !terminal,
        sourceKind: 'hr_request',
        sourceId: row.id,
        routePath: '/hr/talent',
      });
    });
}

function filterWorkItems(items, filter = {}) {
  const q = String(filter?.q || '').trim().toLowerCase();
  const status = String(filter?.status || '').trim().toLowerCase();
  const officeKey = String(filter?.officeKey || '').trim().toLowerCase();
  const needsAction = filter?.needsAction === true || String(filter?.view || '').trim().toLowerCase() === 'needs_action';
  const uid = String(filter?.currentUserId || '').trim();
  return items.filter((item) => {
    if (status && String(item.status || '').trim().toLowerCase() !== status) return false;
    if (officeKey && String(item.responsibleOfficeKey || item.officeKey || '').trim().toLowerCase() !== officeKey) {
      return false;
    }
    if (needsAction) {
      const assigned = String(item.responsibleUserId || '').trim();
      if (assigned && uid && assigned !== uid) return false;
      if (!item.requiresResponse && !item.requiresApproval) return false;
    }
    if (q && !workItemSearchBlob(item).includes(q)) return false;
    return true;
  });
}

export function listPersistedWorkItems(db, scope, user, filter = {}) {
  if (!workRegistryTablesReady(db)) return [];
  const args = [];
  let sql = `${WORK_ITEM_FILING_JOIN_SQL} WHERE (wi.archived_at_iso IS NULL OR TRIM(COALESCE(wi.archived_at_iso,'')) = '')`;
  if (!scope?.viewAll) {
    sql += ` AND wi.branch_id = ?`;
    args.push(String(scope?.branchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID);
  }
  sql += ` ORDER BY wi.updated_at_iso DESC LIMIT 400`;
  const rows = db.prepare(sql).all(...args);
  return filterWorkItems(
    rows
      .filter((row) => userCanSeePersistedWorkItem(db, scope, user, row))
      .map((row) => mapPersistedWorkItemRow(row, loadWorkItemVisibility(db, row.id))),
    { ...filter, currentUserId: user?.id }
  );
}

export function listUnifiedWorkItems(db, scope, user, filter = {}) {
  const persisted = listPersistedWorkItems(db, scope, user, filter);
  const existingSources = collectPersistedSourceKeys(persisted);
  const legacy = [
    ...listLegacyManagementWorkItems(db, scope, user),
    ...listLegacyEditApprovalWorkItems(db, user),
    ...listLegacyCoilRequestWorkItems(db, scope, user),
    ...listLegacyHrRequestWorkItems(db, scope, user),
    ...listLegacyHrDisciplineCaseWorkItems(db, scope, user),
    ...listLegacyHrPerformanceReviewWorkItems(db, scope, user),
  ].filter((item) => {
    const key = persistedSourceKey(item);
    return !key || !existingSources.has(key);
  });
  const all = filterWorkItems([...persisted, ...legacy], { ...filter, currentUserId: user?.id });
  all.sort((a, b) => String(b.updatedAtIso || b.createdAtIso || '').localeCompare(String(a.updatedAtIso || a.createdAtIso || '')));
  const limit = Math.min(Math.max(Number(filter?.limit) || 120, 1), 400);
  return all.slice(0, limit);
}

export function getUnifiedWorkItem(db, scope, user, workItemId) {
  const wid = String(workItemId || '').trim();
  if (!wid) return { ok: false, error: 'Work item id is required.' };
  if (workRegistryTablesReady(db)) {
    const row = db.prepare(`SELECT * FROM work_items WHERE id = ?`).get(wid);
    if (row) {
      if (!userCanSeePersistedWorkItem(db, scope, user, row)) return { ok: false, error: 'Forbidden.' };
      return { ok: true, item: mapPersistedWorkItemRow(row, loadWorkItemVisibility(db, row.id)) };
    }
  }
  const legacy = listUnifiedWorkItems(db, scope, user, { limit: 400 });
  const item = legacy.find((entry) => entry.id === wid);
  if (!item) return { ok: false, error: 'Work item not found.' };
  return { ok: true, item };
}

export function listMaterialRequests(db, scope) {
  if (!workRegistryTablesReady(db)) return [];
  const args = [];
  let sql = `SELECT * FROM material_requests WHERE 1=1`;
  if (!scope?.viewAll) {
    sql += ` AND branch_id = ?`;
    args.push(String(scope?.branchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID);
  }
  sql += ` ORDER BY requested_at_iso DESC`;
  const lineStmt = db.prepare(
    `SELECT * FROM material_request_lines WHERE material_request_id = ? ORDER BY line_no ASC`
  );
  return db
    .prepare(sql)
    .all(...args)
    .map((row) => ({
      id: row.id,
      referenceNo: row.reference_no,
      branchId: row.branch_id,
      requestCategory: row.request_category,
      status: row.status,
      urgency: row.urgency,
      requestedByUserId: row.requested_by_user_id || '',
      requestedByDisplay: row.requested_by_display || '',
      requestedAtIso: row.requested_at_iso,
      requiredByIso: row.required_by_iso || '',
      acknowledgedAtIso: row.acknowledged_at_iso || '',
      approvedAtIso: row.approved_at_iso || '',
      approvedByUserId: row.approved_by_user_id || '',
      approvedByDisplay: row.approved_by_display || '',
      approvalNote: row.approval_note || '',
      responsibleOfficeKey: row.responsible_office_key || 'procurement',
      summary: row.summary,
      note: row.note || '',
      relatedPurchaseOrderId: row.related_purchase_order_id || '',
      relatedWorkItemId: row.related_work_item_id || '',
      sourceKind: row.source_kind || '',
      sourceId: row.source_id || '',
      data: safeJsonParse(row.data_json, {}),
      lines: lineStmt.all(row.id).map((line) => ({
        lineNo: line.line_no,
        itemCategory: line.item_category,
        productId: line.product_id || '',
        itemName: line.item_name || '',
        gauge: line.gauge || '',
        colour: line.colour || '',
        materialType: line.material_type || '',
        unit: line.unit,
        qtyRequested: Number(line.qty_requested) || 0,
        qtyApproved: line.qty_approved != null ? Number(line.qty_approved) : null,
        qtyReceived: Number(line.qty_received) || 0,
        note: line.note || '',
      })),
    }));
}

export function createMaterialRequest(db, payload, actor, workspaceBranchId = DEFAULT_BRANCH_ID) {
  const branchId = String(payload?.branchId || workspaceBranchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
  const lines = Array.isArray(payload?.lines) ? payload.lines : [];
  const validLines = lines
    .map((line, idx) => ({
      lineNo: idx + 1,
      itemCategory: String(line?.itemCategory || line?.kind || 'raw_material').trim() || 'raw_material',
      productId: String(line?.productId || '').trim() || null,
      itemName: String(line?.itemName || '').trim() || null,
      gauge: String(line?.gauge || '').trim() || null,
      colour: String(line?.colour || '').trim() || null,
      materialType: String(line?.materialType || '').trim() || null,
      unit: String(line?.unit || '').trim() || 'unit',
      qtyRequested: Number(line?.qtyRequested ?? line?.requestedKg ?? 0) || 0,
      qtyApproved: null,
      qtyReceived: 0,
      note: String(line?.note || '').trim() || null,
    }))
    .filter((line) => line.qtyRequested > 0 || line.itemName || line.productId);
  if (!validLines.length) return { ok: false, error: 'At least one request line is required.' };
  const id = nextMaterialRequestHumanId(db, branchId);
  const referenceNo = String(payload?.referenceNo || '').trim() || id;
  const requestCategory = String(payload?.requestCategory || 'operational').trim() || 'operational';
  const summary =
    String(payload?.summary || '').trim() ||
    `${requestCategory.replace(/_/g, ' ')} request (${validLines.length} line${validLines.length === 1 ? '' : 's'})`;
  const requestedAtIso = String(payload?.requestedAtIso || '').trim() || nowIso();
  const note = String(payload?.note || '').trim() || null;
  const responsibleOfficeKey =
    String(payload?.responsibleOfficeKey || '').trim() || documentTypeDefaultOfficeKey('material_request');
  const senderDisplayName = String(actor?.displayName || actor?.username || '').trim();
  let workItemId = null;
  db.transaction(() => {
    db.prepare(
      `INSERT INTO material_requests (
        id, reference_no, branch_id, request_category, status, urgency, requested_by_user_id, requested_by_display,
        requested_at_iso, required_by_iso, acknowledged_at_iso, approved_at_iso, approved_by_user_id,
        approved_by_display, approval_note, responsible_office_key, summary, note, related_purchase_order_id,
        related_work_item_id, source_kind, source_id, data_json
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      id,
      referenceNo,
      branchId,
      requestCategory,
      'pending',
      String(payload?.urgency || 'normal').trim() || 'normal',
      String(actor?.id || '').trim() || null,
      senderDisplayName || null,
      requestedAtIso,
      normalizedDate(payload?.requiredByIso),
      null,
      null,
      null,
      null,
      null,
      responsibleOfficeKey,
      summary,
      note,
      null,
      null,
      String(payload?.sourceKind || '').trim() || null,
      String(payload?.sourceId || '').trim() || null,
      payload?.data != null ? JSON.stringify(payload.data) : null
    );
    const lineInsert = db.prepare(
      `INSERT INTO material_request_lines (
        material_request_id, line_no, item_category, product_id, item_name, gauge, colour, material_type,
        unit, qty_requested, qty_approved, qty_received, note
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
    );
    for (const line of validLines) {
      lineInsert.run(
        id,
        line.lineNo,
        line.itemCategory,
        line.productId,
        line.itemName,
        line.gauge,
        line.colour,
        line.materialType,
        line.unit,
        line.qtyRequested,
        line.qtyApproved,
        line.qtyReceived,
        line.note
      );
    }
    const workItem = createWorkItem(db, {
      actor,
      branchId,
      officeKey: 'operations',
      responsibleOfficeKey,
      documentClass: 'request',
      documentType: 'material_request',
      status: 'pending_review',
      priority: payload?.urgency || 'normal',
      title: summary,
      summary: note || summary,
      body: note || '',
      senderUserId: actor?.id || '',
      senderDisplayName,
      senderRoleKey: actor?.roleKey || '',
      senderOfficeKey: officeKeyForUser(actor),
      senderBranchId: branchId,
      sourceKind: 'material_request',
      sourceId: id,
      requiresResponse: true,
      requiresApproval: true,
      links: [{ entityKind: 'material_request', entityId: id }],
      data: {
        requestCategory,
        urgency: String(payload?.urgency || 'normal').trim() || 'normal',
        lineCount: validLines.length,
        routePath: '/operations',
        routeState: { focusOpsTab: 'inventory' },
      },
      visibilityEntries: [
        { visibilityKind: 'user_id', visibilityValue: String(actor?.id || '').trim() },
        { visibilityKind: 'office_key', visibilityValue: responsibleOfficeKey },
        { visibilityKind: 'office_key', visibilityValue: 'branch_manager' },
      ],
    });
    if (workItem.ok) {
      workItemId = workItem.item.id;
      db.prepare(`UPDATE material_requests SET related_work_item_id = ? WHERE id = ?`).run(workItemId, id);
      if (String(payload?.sourceKind || '').trim() === 'coil_request' && String(payload?.sourceId || '').trim()) {
        db.prepare(`UPDATE coil_requests SET material_request_id = ?, work_item_id = ? WHERE id = ?`).run(
          id,
          workItemId,
          String(payload.sourceId).trim()
        );
      }
    }
  })();
  appendAuditLog(db, {
    actor,
    action: 'material_request.create',
    entityKind: 'material_request',
    entityId: id,
    note: summary,
    details: { requestCategory, lineCount: validLines.length, workItemId },
  });
  const row = listMaterialRequests(db, { viewAll: true, branchId }).find((item) => item.id === id);
  return { ok: true, request: row };
}

export function createMachine(db, body, actor, workspaceBranchId = DEFAULT_BRANCH_ID) {
  const branchId = String(body?.branchId || workspaceBranchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
  const name = String(body?.name || '').trim();
  if (!name) return { ok: false, error: 'Machine name is required.' };
  const id = nextMachineHumanId(db, branchId);
  const referenceNo = String(body?.referenceNo || '').trim() || id;
  const now = nowIso();
  db.prepare(
    `INSERT INTO machines (
      id, reference_no, branch_id, name, machine_code, line_name, machine_type, status, asset_category, serial_no,
      model_no, manufacturer, installed_at_iso, commissioned_at_iso, legacy_machine_name, notes,
      created_at_iso, updated_at_iso, created_by_user_id, updated_by_user_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    referenceNo,
    branchId,
    name,
    String(body?.machineCode || '').trim() || null,
    String(body?.lineName || '').trim() || null,
    String(body?.machineType || '').trim() || null,
    String(body?.status || 'active').trim() || 'active',
    String(body?.assetCategory || '').trim() || null,
    String(body?.serialNo || '').trim() || null,
    String(body?.modelNo || '').trim() || null,
    String(body?.manufacturer || '').trim() || null,
    normalizedDate(body?.installedAtIso),
    normalizedDate(body?.commissionedAtIso),
    String(body?.legacyMachineName || '').trim() || null,
    String(body?.notes || '').trim() || null,
    now,
    now,
    String(actor?.id || '').trim() || null,
    String(actor?.id || '').trim() || null
  );
  appendAuditLog(db, {
    actor,
    action: 'machine.create',
    entityKind: 'machine',
    entityId: id,
    note: name,
  });
  return { ok: true, machineId: id };
}

export function linkMachineAsset(db, machineId, assetId, actor = null, relationKind = 'primary') {
  const mid = String(machineId || '').trim();
  const aid = String(assetId || '').trim();
  if (!mid || !aid) return { ok: false, error: 'machineId and assetId are required.' };
  const machine = db.prepare(`SELECT id FROM machines WHERE id = ?`).get(mid);
  if (!machine) return { ok: false, error: 'Machine not found.' };
  const asset = db.prepare(`SELECT id FROM fixed_assets WHERE id = ?`).get(aid);
  if (!asset) return { ok: false, error: 'Asset not found.' };
  db.prepare(
    `INSERT OR REPLACE INTO machine_asset_links (machine_id, asset_id, relation_kind) VALUES (?,?,?)`
  ).run(mid, aid, String(relationKind || 'primary').trim() || 'primary');
  appendAuditLog(db, {
    actor,
    action: 'machine.asset_link',
    entityKind: 'machine',
    entityId: mid,
    note: aid,
    details: { assetId: aid, relationKind },
  });
  return { ok: true };
}

export function recordMachineMeterLog(db, body, actor, workspaceBranchId = DEFAULT_BRANCH_ID) {
  const machineId = String(body?.machineId || '').trim();
  if (!machineId) return { ok: false, error: 'machineId is required.' };
  const machine = db.prepare(`SELECT id, branch_id FROM machines WHERE id = ?`).get(machineId);
  if (!machine) return { ok: false, error: 'Machine not found.' };
  const outputMeters = Math.max(0, Number(body?.outputMeters) || 0);
  if (outputMeters <= 0) return { ok: false, error: 'outputMeters must be greater than zero.' };
  const id = nextInTransitLoadHumanId(db, machine.branch_id || workspaceBranchId || DEFAULT_BRANCH_ID).replace(/^MT-/, 'MM-');
  const readingDateIso = String(body?.readingDateIso || '').trim() || new Date().toISOString().slice(0, 10);
  const createdAtIso = nowIso();
  db.prepare(
    `INSERT INTO machine_meter_logs (
      id, machine_id, reading_date_iso, output_meters, note, source_kind, source_id, created_at_iso, created_by_user_id
    ) VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    machineId,
    readingDateIso,
    outputMeters,
    String(body?.note || '').trim() || null,
    String(body?.sourceKind || '').trim() || null,
    String(body?.sourceId || '').trim() || null,
    createdAtIso,
    String(actor?.id || '').trim() || null
  );
  appendAuditLog(db, {
    actor,
    action: 'machine.meter_log',
    entityKind: 'machine',
    entityId: machineId,
    note: `${outputMeters} m`,
  });
  return { ok: true, logId: id };
}

export function listMachines(db, scope) {
  const args = [];
  let sql = `SELECT * FROM machines WHERE 1=1`;
  if (!scope?.viewAll) {
    sql += ` AND branch_id = ?`;
    args.push(String(scope?.branchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID);
  }
  sql += ` ORDER BY name COLLATE NOCASE`;
  const assetsByMachine = new Map();
  const linkRows = db.prepare(`SELECT machine_id, asset_id, relation_kind FROM machine_asset_links`).all();
  for (const row of linkRows) {
    const list = assetsByMachine.get(row.machine_id) || [];
    list.push({ assetId: row.asset_id, relationKind: row.relation_kind || 'primary' });
    assetsByMachine.set(row.machine_id, list);
  }
  const latestMeterByMachine = new Map();
  const meterRows = db
    .prepare(
      `SELECT machine_id, reading_date_iso, output_meters
       FROM machine_meter_logs
       ORDER BY reading_date_iso DESC, created_at_iso DESC`
    )
    .all();
  for (const row of meterRows) {
    if (latestMeterByMachine.has(row.machine_id)) continue;
    latestMeterByMachine.set(row.machine_id, {
      readingDateIso: row.reading_date_iso,
      outputMeters: Number(row.output_meters) || 0,
    });
  }
  return db.prepare(sql).all(...args).map((row) => ({
    id: row.id,
    referenceNo: row.reference_no,
    branchId: row.branch_id,
    name: row.name,
    machineCode: row.machine_code || '',
    lineName: row.line_name || '',
    machineType: row.machine_type || '',
    status: row.status,
    assetCategory: row.asset_category || '',
    serialNo: row.serial_no || '',
    modelNo: row.model_no || '',
    manufacturer: row.manufacturer || '',
    installedAtIso: row.installed_at_iso || '',
    commissionedAtIso: row.commissioned_at_iso || '',
    legacyMachineName: row.legacy_machine_name || '',
    notes: row.notes || '',
    createdAtIso: row.created_at_iso,
    updatedAtIso: row.updated_at_iso,
    linkedAssets: assetsByMachine.get(row.id) || [],
    latestMeterLog: latestMeterByMachine.get(row.id) || null,
  }));
}

export function listMachineLinkableAssets(db, scope) {
  const args = [];
  let sql = `SELECT id, name, category, branch_id, status FROM fixed_assets WHERE status = 'active'`;
  if (!scope?.viewAll) {
    sql += ` AND branch_id = ?`;
    args.push(String(scope?.branchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID);
  }
  sql += ` ORDER BY name COLLATE NOCASE`;
  return db.prepare(sql).all(...args).map((row) => ({
    id: row.id,
    name: row.name,
    category: row.category,
    branchId: row.branch_id,
    status: row.status,
  }));
}

export function createMaintenancePlan(db, body, actor, workspaceBranchId = DEFAULT_BRANCH_ID) {
  const branchId = String(body?.branchId || workspaceBranchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
  const machineId = String(body?.machineId || '').trim();
  if (!machineId) return { ok: false, error: 'machineId is required.' };
  const summary = String(body?.summary || '').trim();
  if (!summary) return { ok: false, error: 'Plan summary is required.' };
  const id = nextMaintenancePlanHumanId(db, branchId);
  const referenceNo = String(body?.referenceNo || '').trim() || id;
  const now = nowIso();
  db.prepare(
    `INSERT INTO maintenance_plans (
      id, reference_no, branch_id, machine_id, status, plan_kind, summary, calendar_interval_days, meter_interval,
      next_due_date_iso, next_due_meter, last_service_at_iso, last_service_meter, approval_required,
      responsible_office_key, notes, created_at_iso, updated_at_iso, created_by_user_id, updated_by_user_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    referenceNo,
    branchId,
    machineId,
    String(body?.status || 'active').trim() || 'active',
    String(body?.planKind || 'preventive').trim() || 'preventive',
    summary,
    body?.calendarIntervalDays != null ? Math.max(0, Math.round(Number(body.calendarIntervalDays) || 0)) : null,
    body?.meterInterval != null ? Math.max(0, Number(body.meterInterval) || 0) : null,
    normalizedDate(body?.nextDueDateIso),
    body?.nextDueMeter != null ? Number(body.nextDueMeter) || 0 : null,
    normalizedDate(body?.lastServiceAtIso),
    body?.lastServiceMeter != null ? Number(body.lastServiceMeter) || 0 : null,
    body?.approvalRequired === false ? 0 : 1,
    String(body?.responsibleOfficeKey || 'operations').trim() || 'operations',
    String(body?.notes || '').trim() || null,
    now,
    now,
    String(actor?.id || '').trim() || null,
    String(actor?.id || '').trim() || null
  );
  appendAuditLog(db, {
    actor,
    action: 'maintenance_plan.create',
    entityKind: 'maintenance_plan',
    entityId: id,
    note: summary,
  });
  return { ok: true, planId: id };
}

export function listMaintenancePlans(db, scope) {
  const args = [];
  let sql = `SELECT * FROM maintenance_plans WHERE 1=1`;
  if (!scope?.viewAll) {
    sql += ` AND branch_id = ?`;
    args.push(String(scope?.branchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID);
  }
  sql += ` ORDER BY next_due_date_iso ASC, next_due_meter ASC, updated_at_iso DESC`;
  return db.prepare(sql).all(...args).map((row) => ({
    id: row.id,
    referenceNo: row.reference_no,
    branchId: row.branch_id,
    machineId: row.machine_id,
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
  }));
}

export function createMaintenanceWorkOrder(db, body, actor, workspaceBranchId = DEFAULT_BRANCH_ID) {
  const branchId = String(body?.branchId || workspaceBranchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
  const machineId = String(body?.machineId || '').trim();
  if (!machineId) return { ok: false, error: 'machineId is required.' };
  const summary = String(body?.summary || '').trim();
  if (!summary) return { ok: false, error: 'Work order summary is required.' };
  const id = nextMaintenanceWorkOrderHumanId(db, branchId);
  const referenceNo = String(body?.referenceNo || '').trim() || id;
  const openedAtIso = String(body?.openedAtIso || '').trim() || nowIso();
  let workItemId = null;
  db.transaction(() => {
    db.prepare(
      `INSERT INTO maintenance_work_orders (
        id, reference_no, branch_id, machine_id, plan_id, status, priority, kind, summary, symptom, diagnosis,
        resolution, incident_date_iso, opened_at_iso, acknowledged_at_iso, approved_at_iso, closed_at_iso,
        opened_by_user_id, acknowledged_by_user_id, approved_by_user_id, closed_by_user_id, assigned_to_user_id,
        downtime_hours, vendor_name, replacement_required, related_material_request_id, related_payment_request_id,
        related_work_item_id, data_json
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      id,
      referenceNo,
      branchId,
      machineId,
      String(body?.planId || '').trim() || null,
      String(body?.status || 'open').trim() || 'open',
      String(body?.priority || 'normal').trim() || 'normal',
      String(body?.kind || 'corrective').trim() || 'corrective',
      summary,
      String(body?.symptom || '').trim() || null,
      String(body?.diagnosis || '').trim() || null,
      String(body?.resolution || '').trim() || null,
      normalizedDate(body?.incidentDateIso),
      openedAtIso,
      normalizedDate(body?.acknowledgedAtIso),
      normalizedDate(body?.approvedAtIso),
      normalizedDate(body?.closedAtIso),
      String(actor?.id || '').trim() || null,
      null,
      null,
      null,
      String(body?.assignedToUserId || '').trim() || null,
      Number(body?.downtimeHours) || 0,
      String(body?.vendorName || '').trim() || null,
      body?.replacementRequired ? 1 : 0,
      String(body?.relatedMaterialRequestId || '').trim() || null,
      String(body?.relatedPaymentRequestId || '').trim() || null,
      null,
      body?.data != null ? JSON.stringify(body.data) : null
    );
    const workItem = createWorkItem(db, {
      actor,
      branchId,
      officeKey: 'operations',
      responsibleOfficeKey: 'branch_manager',
      documentClass: 'work_order',
      documentType: 'maintenance_work_order',
      status: 'pending_review',
      priority: body?.priority || 'normal',
      title: summary,
      summary: String(body?.symptom || '').trim() || summary,
      body: String(body?.diagnosis || '').trim() || '',
      senderUserId: actor?.id || '',
      senderDisplayName: actor?.displayName || actor?.username || '',
      senderRoleKey: actor?.roleKey || '',
      senderOfficeKey: officeKeyForUser(actor),
      senderBranchId: branchId,
      sourceKind: 'maintenance_work_order',
      sourceId: id,
      requiresResponse: true,
      requiresApproval: true,
      links: [
        { entityKind: 'maintenance_work_order', entityId: id },
        { entityKind: 'machine', entityId: machineId },
      ],
      data: {
        priority: String(body?.priority || 'normal').trim() || 'normal',
        kind: String(body?.kind || 'corrective').trim() || 'corrective',
        routePath: '/operations',
        routeState: { focusOpsTab: 'production' },
      },
      visibilityEntries: [
        { visibilityKind: 'user_id', visibilityValue: String(actor?.id || '').trim() },
        { visibilityKind: 'office_key', visibilityValue: 'operations' },
        { visibilityKind: 'office_key', visibilityValue: 'branch_manager' },
      ],
    });
    if (workItem.ok) {
      workItemId = workItem.item.id;
      db.prepare(`UPDATE maintenance_work_orders SET related_work_item_id = ? WHERE id = ?`).run(workItemId, id);
    }
  })();
  appendAuditLog(db, {
    actor,
    action: 'maintenance_work_order.create',
    entityKind: 'maintenance_work_order',
    entityId: id,
    note: summary,
    details: { workItemId },
  });
  return { ok: true, workOrderId: id };
}

export function listMaintenanceWorkOrders(db, scope) {
  const args = [];
  let sql = `SELECT * FROM maintenance_work_orders WHERE 1=1`;
  if (!scope?.viewAll) {
    sql += ` AND branch_id = ?`;
    args.push(String(scope?.branchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID);
  }
  sql += ` ORDER BY opened_at_iso DESC`;
  return db.prepare(sql).all(...args).map((row) => ({
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
    approvedAtIso: row.approved_at_iso || '',
    closedAtIso: row.closed_at_iso || '',
    assignedToUserId: row.assigned_to_user_id || '',
    downtimeHours: Number(row.downtime_hours) || 0,
    vendorName: row.vendor_name || '',
    replacementRequired: Boolean(row.replacement_required),
    relatedMaterialRequestId: row.related_material_request_id || '',
    relatedPaymentRequestId: row.related_payment_request_id || '',
    relatedWorkItemId: row.related_work_item_id || '',
    data: safeJsonParse(row.data_json, {}),
  }));
}

export function appendMaintenanceEvent(db, workOrderId, body, actor) {
  const wid = String(workOrderId || '').trim();
  if (!wid) return { ok: false, error: 'workOrderId is required.' };
  const row = db.prepare(`SELECT * FROM maintenance_work_orders WHERE id = ?`).get(wid);
  if (!row) return { ok: false, error: 'Work order not found.' };
  const eventKind = String(body?.eventKind || 'note').trim() || 'note';
  const note = String(body?.note || '').trim();
  if (!note) return { ok: false, error: 'Event note is required.' };
  const id = nextMaintenanceEventHumanId(db, row.branch_id || DEFAULT_BRANCH_ID);
  const atIso = String(body?.atIso || '').trim() || nowIso();
  db.prepare(
    `INSERT INTO maintenance_events (
      id, work_order_id, event_kind, note, at_iso, actor_user_id, actor_display_name, actor_office_key, data_json
    ) VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    wid,
    eventKind,
    note,
    atIso,
    String(actor?.id || '').trim() || null,
    String(actor?.displayName || actor?.username || '').trim() || null,
    officeKeyForUser(actor),
    body?.data != null ? JSON.stringify(body.data) : null
  );
  db.prepare(`UPDATE maintenance_work_orders SET status = ?, closed_at_iso = ? WHERE id = ?`).run(
    eventKind === 'closed' ? 'closed' : row.status,
    eventKind === 'closed' ? atIso : row.closed_at_iso,
    wid
  );
  appendAuditLog(db, {
    actor,
    action: 'maintenance_event.create',
    entityKind: 'maintenance_work_order',
    entityId: wid,
    note,
    details: { eventKind, eventId: id },
  });
  return { ok: true, eventId: id };
}

export function createHrPerformanceReview(db, body, actor, workspaceBranchId = DEFAULT_BRANCH_ID) {
  const branchId = String(body?.branchId || workspaceBranchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID;
  const userId = String(body?.userId || '').trim();
  if (!userId) return { ok: false, error: 'userId is required.' };
  const periodKey = String(body?.periodKey || '').trim();
  if (!periodKey) return { ok: false, error: 'periodKey is required.' };
  const id = nextHrPerformanceReviewHumanId(db, branchId);
  const referenceNo = String(body?.referenceNo || '').trim() || id;
  const now = nowIso();
  db.prepare(
    `INSERT INTO hr_performance_reviews (
      id, reference_no, branch_id, user_id, machine_id, department_key, period_key, status, review_type,
      reviewer_user_id, branch_recommendation, hr_final_note, score_json, linked_work_item_id, created_at_iso, updated_at_iso
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    referenceNo,
    branchId,
    userId,
    String(body?.machineId || '').trim() || null,
    String(body?.departmentKey || '').trim() || null,
    periodKey,
    String(body?.status || 'draft').trim() || 'draft',
    String(body?.reviewType || 'periodic').trim() || 'periodic',
    String(body?.reviewerUserId || actor?.id || '').trim() || null,
    String(body?.branchRecommendation || '').trim() || null,
    String(body?.hrFinalNote || '').trim() || null,
    body?.score != null ? JSON.stringify(body.score) : null,
    null,
    now,
    now
  );
  appendAuditLog(db, {
    actor,
    action: 'hr.performance_review.create',
    entityKind: 'hr_performance_review',
    entityId: id,
    note: periodKey,
    details: { userId },
  });
  return { ok: true, reviewId: id };
}

export function listHrPerformanceReviews(db, scope) {
  const args = [];
  let sql = `SELECT * FROM hr_performance_reviews WHERE 1=1`;
  if (!scope?.viewAll) {
    sql += ` AND branch_id = ?`;
    args.push(String(scope?.branchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID);
  }
  sql += ` ORDER BY updated_at_iso DESC`;
  return db.prepare(sql).all(...args).map((row) => ({
    id: row.id,
    referenceNo: row.reference_no,
    branchId: row.branch_id,
    userId: row.user_id,
    machineId: row.machine_id || '',
    departmentKey: row.department_key || '',
    periodKey: row.period_key,
    status: row.status,
    reviewType: row.review_type,
    reviewerUserId: row.reviewer_user_id || '',
    branchRecommendation: row.branch_recommendation || '',
    hrFinalNote: row.hr_final_note || '',
    score: safeJsonParse(row.score_json, {}),
    linkedWorkItemId: row.linked_work_item_id || '',
    createdAtIso: row.created_at_iso,
    updatedAtIso: row.updated_at_iso,
  }));
}

function listLegacyHrDisciplineCaseWorkItems(db, scope, user) {
  const canSee =
    userHasPermission(user, 'hr.staff.manage') ||
    userHasPermission(user, 'hr.requests.hr_review') ||
    userHasPermission(user, 'hr.requests.final_approve') ||
    userHasPermission(user, '*');
  if (!canSee) return [];
  let sql = `SELECT * FROM hr_discipline_cases WHERE 1=1`;
  const args = [];
  if (!scope?.viewAll) {
    sql += ` AND branch_id = ?`;
    args.push(String(scope?.branchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID);
  }
  sql += ` ORDER BY opened_at_iso DESC LIMIT 150`;
  return db.prepare(sql).all(...args).map((row) =>
    legacyWorkItemBase({
      id: legacyItemId('hr-discipline-case', row.id),
      referenceNo: row.id,
      branchId: row.branch_id || DEFAULT_BRANCH_ID,
      officeKey: 'hr',
      responsibleOfficeKey: 'hr',
      documentClass: 'case_file',
      documentType: 'hr_discipline_case',
      status: row.status || 'open',
      priority: 'high',
      title: row.summary || `Discipline case ${row.id}`,
      summary: row.offence_category || 'Disciplinary case',
      createdAtIso: row.opened_at_iso || '',
      sourceKind: 'hr_discipline_case',
      sourceId: row.id,
      routePath: '/hr/talent',
    })
  );
}

function listLegacyHrPerformanceReviewWorkItems(db, scope, user) {
  const canSee =
    userHasPermission(user, 'hr.staff.manage') ||
    userHasPermission(user, 'hr.requests.hr_review') ||
    userHasPermission(user, 'hr.requests.final_approve') ||
    userHasPermission(user, '*');
  if (!canSee) return [];
  return listHrPerformanceReviews(db, scope).map((row) =>
    legacyWorkItemBase({
      id: legacyItemId('hr-performance-review', row.id),
      referenceNo: row.referenceNo || row.id,
      branchId: row.branchId || DEFAULT_BRANCH_ID,
      officeKey: 'hr',
      responsibleOfficeKey: 'hr',
      documentClass: 'report',
      documentType: 'performance_review',
      status: row.status || 'draft',
      title: `Performance review ${row.periodKey}`,
      summary: `${row.userId || ''}${row.machineId ? ` · ${row.machineId}` : ''}`.trim(),
      createdAtIso: row.createdAtIso || '',
      updatedAtIso: row.updatedAtIso || row.createdAtIso || '',
      sourceKind: 'hr_performance_review',
      sourceId: row.id,
      routePath: '/hr/talent',
    })
  );
}
