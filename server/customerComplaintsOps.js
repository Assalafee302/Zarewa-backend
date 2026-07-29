/**
 * Customer complaint cases (separate from freeform CRM notes).
 */
import { nextCustomerComplaintHumanId } from './humanId.js';
import { DEFAULT_BRANCH_ID, listBranches } from './branches.js';
import { appendAuditLog } from './controlOps.js';

export const COMPLAINT_CHANNELS = ['phone', 'whatsapp', 'in_person', 'email'];
export const COMPLAINT_CATEGORIES = [
  'product_quality',
  'delivery_delay',
  'billing_dispute',
  'service',
  'other',
];
export const COMPLAINT_SEVERITIES = ['low', 'high', 'urgent'];
export const COMPLAINT_STATUSES = ['open', 'acknowledged', 'in_progress', 'resolved', 'closed'];

const OPEN_STATUSES = new Set(['open', 'acknowledged', 'in_progress']);

function nowIso() {
  return new Date().toISOString();
}

function normEnum(value, allowed, fallback) {
  const v = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
  if (allowed.includes(v)) return v;
  return fallback;
}

/**
 * Active Branch Manager for a branch (sales_manager / branch_manager on staff profile).
 * @param {import('better-sqlite3').Database} db
 * @param {string} branchId
 * @returns {{ userId: string, displayName: string } | null}
 */
export function findBranchManagerForBranch(db, branchId) {
  const bid = String(branchId || '').trim();
  if (!bid) return null;
  const row = db
    .prepare(
      `SELECT u.id AS user_id, u.display_name AS display_name, u.username AS username
       FROM app_users u
       LEFT JOIN hr_staff_profiles p ON p.user_id = u.id
       WHERE LOWER(COALESCE(u.status, 'active')) = 'active'
         AND LOWER(COALESCE(u.role_key, '')) IN ('sales_manager', 'branch_manager')
         AND (
           TRIM(COALESCE(p.branch_id, '')) = ?
           OR TRIM(COALESCE(u.workspace_branch_id, '')) = ?
         )
       ORDER BY CASE WHEN TRIM(COALESCE(p.branch_id, '')) = ? THEN 0 ELSE 1 END, u.display_name COLLATE NOCASE
       LIMIT 1`
    )
    .get(bid, bid, bid);
  if (!row?.user_id) return null;
  return {
    userId: String(row.user_id),
    displayName: String(row.display_name || row.username || row.user_id).trim(),
  };
}

/**
 * Branches with no active Branch Manager — for MD/admin governance attention.
 * @param {import('better-sqlite3').Database} db
 */
export function listBranchesMissingBranchManager(db) {
  const branches = listBranches(db);
  const out = [];
  for (const b of branches) {
    const id = String(b.id || '').trim();
    if (!id) continue;
    if (findBranchManagerForBranch(db, id)) continue;
    out.push({
      branchId: id,
      branchName: String(b.name || id).trim(),
    });
  }
  return out;
}

function mapComplaintRow(row, extras = {}) {
  if (!row) return null;
  let data = {};
  try {
    data = row.data_json ? JSON.parse(row.data_json) : {};
  } catch {
    data = {};
  }
  return {
    id: row.id,
    customerId: row.customer_id,
    customerName: extras.customerName || row.customer_name || '',
    branchId: row.branch_id,
    channel: row.channel,
    category: row.category,
    severity: row.severity,
    description: row.description,
    linkedOrderId: row.linked_order_id || '',
    status: row.status,
    assignedToUserId: row.assigned_to_user_id || '',
    assignedToDisplayName: extras.assignedToDisplayName || '',
    openedByUserId: row.opened_by_user_id || '',
    openedByName: row.opened_by_name || '',
    openedAtIso: row.opened_at_iso,
    resolutionNote: row.resolution_note || '',
    resolvedAtIso: row.resolved_at_iso || '',
    resolvedByUserId: row.resolved_by_user_id || '',
    relatedRefundId: row.related_refund_id || '',
    relatedPaymentRequestId: row.related_payment_request_id || '',
    updatedAtIso: row.updated_at_iso || '',
    assignmentFallback: Boolean(data.assignmentFallback),
    missingBranchManager: Boolean(data.missingBranchManager),
    data,
  };
}

function loadAssigneeName(db, userId) {
  const id = String(userId || '').trim();
  if (!id) return '';
  const row = db.prepare(`SELECT display_name, username FROM app_users WHERE id = ?`).get(id);
  return String(row?.display_name || row?.username || '').trim();
}

function loadCustomerName(db, customerId) {
  const row = db.prepare(`SELECT name FROM customers WHERE customer_id = ?`).get(String(customerId || '').trim());
  return String(row?.name || '').trim();
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} body
 * @param {object} actor
 * @param {string} workspaceBranchId
 */
export function createCustomerComplaint(db, body, actor, workspaceBranchId) {
  const customerId = String(body?.customerId || body?.customerID || '').trim();
  if (!customerId) return { ok: false, error: 'customerId is required.' };
  const customer = db.prepare(`SELECT customer_id, name, branch_id FROM customers WHERE customer_id = ?`).get(customerId);
  if (!customer) return { ok: false, error: 'Customer not found.' };

  const branchId =
    String(customer.branch_id || '').trim() ||
    String(workspaceBranchId || body?.branchId || DEFAULT_BRANCH_ID).trim() ||
    DEFAULT_BRANCH_ID;

  const channel = normEnum(body?.channel, COMPLAINT_CHANNELS, '');
  if (!channel) return { ok: false, error: 'channel is required (phone, whatsapp, in_person, email).' };
  const category = normEnum(body?.category, COMPLAINT_CATEGORIES, '');
  if (!category) {
    return {
      ok: false,
      error: 'category is required (product_quality, delivery_delay, billing_dispute, service, other).',
    };
  }
  const severity = normEnum(body?.severity, COMPLAINT_SEVERITIES, 'low');
  const description = String(body?.description || '').trim();
  if (!description) return { ok: false, error: 'description is required.' };
  const linkedOrderId = String(body?.linkedOrderId || body?.quotationRef || '').trim() || null;

  const bm = findBranchManagerForBranch(db, branchId);
  const openerId = String(actor?.id || '').trim() || null;
  const openerName = String(actor?.displayName || actor?.username || actor?.email || '').trim() || null;
  let assignedToUserId = bm?.userId || null;
  let assignmentFallback = false;
  let missingBranchManager = false;
  if (!assignedToUserId) {
    assignedToUserId = openerId;
    assignmentFallback = true;
    missingBranchManager = true;
  }

  const id = nextCustomerComplaintHumanId(db, branchId);
  const atIso = nowIso();
  const dataJson = JSON.stringify({
    assignmentFallback,
    missingBranchManager,
    fallbackReason: missingBranchManager ? 'no_sales_manager_for_branch' : null,
  });

  db.prepare(
    `INSERT INTO customer_complaints (
      id, customer_id, branch_id, channel, category, severity, description, linked_order_id,
      status, assigned_to_user_id, opened_by_user_id, opened_by_name, opened_at_iso,
      updated_at_iso, data_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    customerId,
    branchId,
    channel,
    category,
    severity,
    description,
    linkedOrderId,
    'open',
    assignedToUserId,
    openerId,
    openerName,
    atIso,
    atIso,
    dataJson
  );

  appendAuditLog(db, {
    actor,
    action: 'customer_complaint.create',
    entityKind: 'customer_complaint',
    entityId: id,
    note: missingBranchManager
      ? `Complaint opened; no Branch Manager for ${branchId} — assigned to opener`
      : 'Complaint opened',
    details: {
      customerId,
      branchId,
      severity,
      assignmentFallback,
      missingBranchManager,
      assignedToUserId,
    },
  });

  const mapped = getCustomerComplaint(db, id);
  return {
    ok: true,
    complaint: mapped,
    assignmentFallback,
    missingBranchManager,
    branchId,
  };
}

export function getCustomerComplaint(db, complaintId) {
  const id = String(complaintId || '').trim();
  if (!id) return null;
  const row = db
    .prepare(
      `SELECT c.*, cu.name AS customer_name
       FROM customer_complaints c
       LEFT JOIN customers cu ON cu.customer_id = c.customer_id
       WHERE c.id = ?`
    )
    .get(id);
  if (!row) return null;
  return mapComplaintRow(row, {
    customerName: row.customer_name,
    assignedToDisplayName: loadAssigneeName(db, row.assigned_to_user_id),
  });
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {{ branchId?: string, viewAll?: boolean, openOnly?: boolean, customerId?: string }} scope
 */
export function listCustomerComplaints(db, scope = {}) {
  const args = [];
  let sql = `
    SELECT c.*, cu.name AS customer_name
    FROM customer_complaints c
    LEFT JOIN customers cu ON cu.customer_id = c.customer_id
    WHERE 1=1
  `;
  if (scope.customerId) {
    sql += ` AND c.customer_id = ?`;
    args.push(String(scope.customerId).trim());
  }
  if (!scope.viewAll) {
    sql += ` AND c.branch_id = ?`;
    args.push(String(scope.branchId || DEFAULT_BRANCH_ID).trim() || DEFAULT_BRANCH_ID);
  } else if (scope.branchId) {
    sql += ` AND c.branch_id = ?`;
    args.push(String(scope.branchId).trim());
  }
  if (scope.openOnly) {
    sql += ` AND LOWER(COALESCE(c.status, '')) IN ('open','acknowledged','in_progress')`;
  }
  sql += `
    ORDER BY
      CASE LOWER(c.severity) WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 ELSE 2 END,
      CASE LOWER(c.status)
        WHEN 'open' THEN 0
        WHEN 'acknowledged' THEN 1
        WHEN 'in_progress' THEN 2
        WHEN 'resolved' THEN 3
        ELSE 4
      END,
      c.opened_at_iso DESC
  `;
  return db.prepare(sql).all(...args).map((row) =>
    mapComplaintRow(row, {
      customerName: row.customer_name,
      assignedToDisplayName: loadAssigneeName(db, row.assigned_to_user_id),
    })
  );
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} complaintId
 * @param {object} body
 * @param {object} actor
 */
export function updateCustomerComplaint(db, complaintId, body, actor) {
  const existing = getCustomerComplaint(db, complaintId);
  if (!existing) return { ok: false, error: 'Complaint not found.' };

  const nextStatus = body?.status != null ? normEnum(body.status, COMPLAINT_STATUSES, existing.status) : existing.status;
  const assignId =
    body?.assignedToUserId !== undefined
      ? String(body.assignedToUserId || '').trim() || null
      : existing.assignedToUserId || null;
  const resolutionNote =
    body?.resolutionNote !== undefined
      ? String(body.resolutionNote || '').trim()
      : existing.resolutionNote || '';
  const relatedRefundId =
    body?.relatedRefundId !== undefined
      ? String(body.relatedRefundId || '').trim() || null
      : existing.relatedRefundId || null;
  const relatedPaymentRequestId =
    body?.relatedPaymentRequestId !== undefined
      ? String(body.relatedPaymentRequestId || '').trim() || null
      : existing.relatedPaymentRequestId || null;

  if ((nextStatus === 'resolved' || nextStatus === 'closed') && !resolutionNote) {
    return { ok: false, error: 'resolutionNote is required to resolve or close a complaint.' };
  }

  const atIso = nowIso();
  const resolvedAt =
    nextStatus === 'resolved' || nextStatus === 'closed'
      ? existing.resolvedAtIso || atIso
      : null;
  const resolvedBy =
    nextStatus === 'resolved' || nextStatus === 'closed'
      ? existing.resolvedByUserId || String(actor?.id || '').trim() || null
      : null;

  // Acknowledge / start progress shortcuts
  let status = nextStatus;
  if (body?.action === 'acknowledge' && existing.status === 'open') status = 'acknowledged';
  if (body?.action === 'start' && OPEN_STATUSES.has(existing.status)) status = 'in_progress';
  if (body?.action === 'resolve') status = 'resolved';
  if (body?.action === 'close') status = 'closed';

  if ((status === 'resolved' || status === 'closed') && !resolutionNote) {
    return { ok: false, error: 'resolutionNote is required to resolve or close a complaint.' };
  }

  db.prepare(
    `UPDATE customer_complaints SET
      status = ?,
      assigned_to_user_id = ?,
      resolution_note = ?,
      resolved_at_iso = ?,
      resolved_by_user_id = ?,
      related_refund_id = ?,
      related_payment_request_id = ?,
      updated_at_iso = ?
     WHERE id = ?`
  ).run(
    status,
    assignId,
    resolutionNote || null,
    status === 'resolved' || status === 'closed' ? resolvedAt || atIso : null,
    status === 'resolved' || status === 'closed'
      ? resolvedBy || String(actor?.id || '').trim() || null
      : null,
    relatedRefundId,
    relatedPaymentRequestId,
    atIso,
    existing.id
  );

  appendAuditLog(db, {
    actor,
    action: 'customer_complaint.update',
    entityKind: 'customer_complaint',
    entityId: existing.id,
    note: `Status ${existing.status} → ${status}`,
    details: { status, assignId, relatedRefundId },
  });

  return { ok: true, complaint: getCustomerComplaint(db, existing.id) };
}

export { loadCustomerName, OPEN_STATUSES };
