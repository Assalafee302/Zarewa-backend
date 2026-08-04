/**
 * Branch overtime (OT) pay requests — storekeeper → branch manager → cashier.
 * Separate from attendance OT board (hr_daily_roll_calls / listOtBoard).
 *
 * Status machine (server-enforced):
 *   draft → pending_bm_approval → approved_by_bm → paid
 *                            ↘ rejected_by_bm (terminal)
 */
import crypto from 'node:crypto';
import { actorId, actorName } from './auth.js';
import { DEFAULT_BRANCH_ID } from './branches.js';
import { appendAuditLog } from './controlOps.js';
import { nextOtRequestHumanId } from './humanId.js';

export const OT_STATUS = {
  DRAFT: 'draft',
  PENDING_BM: 'pending_bm_approval',
  APPROVED: 'approved_by_bm',
  PAID: 'paid',
  REJECTED: 'rejected_by_bm',
};

export const OT_WORK_TYPES = Object.freeze(['production', 'offload', 'other']);

export const OT_PAYMENT_CATEGORIES = Object.freeze([
  'production_ot',
  'stone_coated_offload',
  'other',
]);

/** Statuses cashier may list/view (history includes paid). */
export const OT_CASHIER_VISIBLE_STATUSES = Object.freeze([OT_STATUS.APPROVED, OT_STATUS.PAID]);

/** Statuses BM approval queue focuses on (list filters). */
export const OT_BM_ACTIONABLE_STATUS = OT_STATUS.PENDING_BM;

function nowIso() {
  return new Date().toISOString();
}

function newLineId(prefix) {
  return `${prefix}-${crypto.randomBytes(8).toString('hex')}`;
}

function tableReady(db) {
  try {
    return Boolean(
      db
        .prepare(
          `SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?`
        )
        .get('ot_requests')
    );
  } catch {
    try {
      return Boolean(db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get('ot_requests'));
    } catch {
      return false;
    }
  }
}

function normalizeDayIso(v) {
  const s = String(v ?? '').trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return s;
}

function normalizeTime(v) {
  const s = String(v ?? '').trim();
  if (!s) return null;
  const m = s.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const hh = Math.min(23, Math.max(0, Number(m[1])));
  const mm = Math.min(59, Math.max(0, Number(m[2])));
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
}

function moneyNgn(v) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return null;
  return Math.max(0, n);
}

function qtyNumber(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function actorRoleKey(actor) {
  return String(actor?.roleKey ?? actor?.role_key ?? actor?.role ?? '').trim() || null;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} args
 */
function appendStatusHistory(db, { requestId, fromStatus, toStatus, actor, note, details }) {
  const id = newLineId('OTH');
  const at = nowIso();
  db.prepare(
    `INSERT INTO ot_status_history (
      id, request_id, from_status, to_status, actor_user_id, actor_name, actor_role, note, details_json, at_iso
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).run(
    id,
    requestId,
    fromStatus ?? null,
    toStatus,
    actorId(actor),
    actorName(actor),
    actorRoleKey(actor),
    note ? String(note).trim() : null,
    details ? JSON.stringify(details) : null,
    at
  );
  return { id, atIso: at };
}

function appendOtAudit(db, actor, action, entityId, note, details) {
  try {
    appendAuditLog(db, {
      actor,
      action,
      entityKind: 'ot_request',
      entityId,
      note: note || '',
      details: details || undefined,
    });
  } catch {
    /* audit optional on partial DBs in unit tests */
  }
}

/**
 * Validate roster staff (active app_users). Casual/contract are employment_type on
 * hr_staff_profiles — not a separate table; any roster user is eligible if active.
 * @returns {{ ok: true, lines: object[] } | { ok: false, error: string, code?: string }}
 */
function normalizeStaffLines(db, branchId, rawLines) {
  if (!Array.isArray(rawLines) || rawLines.length === 0) {
    return { ok: false, error: 'At least one staff line is required.', code: 'OT_STAFF_REQUIRED' };
  }
  const out = [];
  const seen = new Set();
  for (let i = 0; i < rawLines.length; i++) {
    const r = rawLines[i];
    const staffUserId = String(r?.staffUserId ?? r?.staff_user_id ?? '').trim();
    if (!staffUserId) {
      return { ok: false, error: `Staff line ${i + 1}: staffUserId is required.`, code: 'OT_STAFF_ID' };
    }
    if (seen.has(staffUserId)) {
      return { ok: false, error: `Duplicate staff UserId ${staffUserId}.`, code: 'OT_STAFF_DUPLICATE' };
    }
    seen.add(staffUserId);
    const user = db
      .prepare(`SELECT id, display_name, username, status FROM app_users WHERE id = ?`)
      .get(staffUserId);
    if (!user) {
      return {
        ok: false,
        error: `Staff ${staffUserId} is not on the roster (app_users).`,
        code: 'OT_STAFF_NOT_ROSTER',
      };
    }
    if (String(user.status || 'active') !== 'active') {
      return { ok: false, error: `Staff ${staffUserId} is not active.`, code: 'OT_STAFF_INACTIVE' };
    }
    let roleLabel = String(r?.roleLabel ?? r?.role_label ?? r?.role ?? '').trim();
    if (!roleLabel) {
      try {
        const prof = db
          .prepare(`SELECT job_title AS jobTitle, branch_id AS branchId FROM hr_staff_profiles WHERE user_id = ?`)
          .get(staffUserId);
        roleLabel = String(prof?.jobTitle || '').trim();
        const profBranch = String(prof?.branchId || '').trim();
        if (profBranch && branchId && profBranch !== branchId) {
          return {
            ok: false,
            error: `Staff ${user.display_name || staffUserId} is assigned to branch ${profBranch}, not ${branchId}.`,
            code: 'OT_STAFF_BRANCH',
          };
        }
      } catch {
        /* profile optional */
      }
    }
    if (!roleLabel) {
      return {
        ok: false,
        error: `Staff line ${i + 1}: role/label is required (job title or role on form).`,
        code: 'OT_STAFF_ROLE',
      };
    }
    const startTime = normalizeTime(r?.startTime ?? r?.start_time);
    const endTime = normalizeTime(r?.endTime ?? r?.end_time);
    if (!startTime || !endTime) {
      return {
        ok: false,
        error: `Staff line ${i + 1}: startTime and endTime (HH:MM) are required.`,
        code: 'OT_STAFF_TIME',
      };
    }
    out.push({
      staffUserId,
      roleLabel,
      startTime,
      endTime,
      sortOrder: i,
    });
  }
  return { ok: true, lines: out };
}

function normalizeWorkDetails(raw) {
  const w = raw && typeof raw === 'object' ? raw : {};
  return {
    materialType: String(w.materialType ?? w.material_type ?? '').trim() || null,
    workDone: String(w.workDone ?? w.work_done ?? '').trim() || null,
    quantity: qtyNumber(w.quantity ?? w.qty) ?? null,
    quantityUnit: String(w.quantityUnit ?? w.quantity_unit ?? '').trim() || null,
    machineArea: String(w.machineArea ?? w.machine_area ?? '').trim() || null,
    actualCompletionTime: normalizeTime(w.actualCompletionTime ?? w.actual_completion_time),
    factoryLockedBy: String(w.factoryLockedBy ?? w.factory_locked_by ?? '').trim() || null,
  };
}

/**
 * @returns {{ ok: true, line: object } | { ok: false, error: string, code?: string }}
 */
function normalizePaymentLine(raw, { forSubmit = false } = {}) {
  const p = raw && typeof raw === 'object' ? raw : {};
  const category = String(p.category ?? '').trim();
  if (!OT_PAYMENT_CATEGORIES.includes(category)) {
    return {
      ok: false,
      error: `category must be one of: ${OT_PAYMENT_CATEGORIES.join(', ')}.`,
      code: 'OT_PAYMENT_CATEGORY',
    };
  }
  const quantity = qtyNumber(p.quantity);
  if (quantity == null || (forSubmit && quantity <= 0)) {
    return { ok: false, error: 'Payment quantity must be a positive number.', code: 'OT_PAYMENT_QTY' };
  }
  const rateRequested = moneyNgn(p.rateRequested ?? p.rate_requested);
  if (rateRequested == null || (forSubmit && rateRequested <= 0)) {
    return { ok: false, error: 'rateRequested must be a positive ₦ amount.', code: 'OT_PAYMENT_RATE' };
  }
  const amountDraft = Math.round(quantity * rateRequested);
  return {
    ok: true,
    line: {
      category,
      quantity,
      rateRequested,
      amountNgn: amountDraft,
      remarks: String(p.remarks ?? '').trim() || null,
    },
  };
}

/**
 * Domain link rules: production ↔ quotation; offload ↔ PO; never both freeform.
 */
function normalizeDomainLinks(workType, body) {
  const quotationRef = String(body?.quotationRef ?? body?.quotation_ref ?? '').trim() || null;
  const productionJobId = String(body?.productionJobId ?? body?.production_job_id ?? '').trim() || null;
  const poId = String(body?.poId ?? body?.po_id ?? '').trim() || null;
  const coilLotRef = String(body?.coilLotRef ?? body?.coil_lot_ref ?? '').trim() || null;

  if (workType === 'production') {
    return {
      quotationRef,
      productionJobId,
      poId: null,
      coilLotRef: null,
    };
  }
  if (workType === 'offload') {
    return {
      quotationRef: null,
      productionJobId: null,
      poId,
      coilLotRef,
    };
  }
  return {
    quotationRef: null,
    productionJobId: null,
    poId: null,
    coilLotRef: null,
  };
}

function validateDomainLinksForSubmit(db, workType, links) {
  if (workType === 'production') {
    if (!links.quotationRef) {
      return { ok: false, error: 'Production OT requires quotation_ref (select a quotation).', code: 'OT_QUOTATION_REQUIRED' };
    }
    const q = db.prepare(`SELECT id FROM quotations WHERE id = ?`).get(links.quotationRef);
    if (!q) {
      return { ok: false, error: `Quotation ${links.quotationRef} not found.`, code: 'OT_QUOTATION_NOT_FOUND' };
    }
    if (links.productionJobId) {
      const job = db
        .prepare(`SELECT job_id FROM production_jobs WHERE job_id = ?`)
        .get(links.productionJobId);
      if (!job) {
        return { ok: false, error: `Production job ${links.productionJobId} not found.`, code: 'OT_JOB_NOT_FOUND' };
      }
    }
  }
  if (workType === 'offload') {
    if (!links.poId) {
      return { ok: false, error: 'Offload OT requires po_id (select a purchase order).', code: 'OT_PO_REQUIRED' };
    }
    const po = db.prepare(`SELECT po_id FROM purchase_orders WHERE po_id = ?`).get(links.poId);
    if (!po) {
      return { ok: false, error: `Purchase order ${links.poId} not found.`, code: 'OT_PO_NOT_FOUND' };
    }
  }
  return { ok: true };
}

function replaceChildren(db, requestId, staffLines, workDetails, paymentLine) {
  db.prepare(`DELETE FROM ot_staff_lines WHERE request_id = ?`).run(requestId);
  db.prepare(`DELETE FROM ot_work_details WHERE request_id = ?`).run(requestId);
  db.prepare(`DELETE FROM ot_payment_line WHERE request_id = ?`).run(requestId);

  const insStaff = db.prepare(
    `INSERT INTO ot_staff_lines (id, request_id, sort_order, staff_user_id, role_label, start_time, end_time)
     VALUES (?,?,?,?,?,?,?)`
  );
  for (const line of staffLines) {
    insStaff.run(
      newLineId('OTS'),
      requestId,
      line.sortOrder,
      line.staffUserId,
      line.roleLabel,
      line.startTime,
      line.endTime
    );
  }

  db.prepare(
    `INSERT INTO ot_work_details (
      request_id, material_type, work_done, quantity, quantity_unit, machine_area,
      actual_completion_time, factory_locked_by
    ) VALUES (?,?,?,?,?,?,?,?)`
  ).run(
    requestId,
    workDetails.materialType,
    workDetails.workDone,
    workDetails.quantity,
    workDetails.quantityUnit,
    workDetails.machineArea,
    workDetails.actualCompletionTime,
    workDetails.factoryLockedBy
  );

  db.prepare(
    `INSERT INTO ot_payment_line (
      request_id, category, quantity, rate_requested, rate_approved, amount_ngn, remarks, variance_reason
    ) VALUES (?,?,?,?,?,?,?,?)`
  ).run(
    requestId,
    paymentLine.category,
    paymentLine.quantity,
    paymentLine.rateRequested,
    paymentLine.rateApproved ?? null,
    paymentLine.amountNgn,
    paymentLine.remarks,
    paymentLine.varianceReason ?? null
  );
}

function mapRequestRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    dayIso: row.day_iso,
    branchId: row.branch_id,
    workType: row.work_type,
    reason: row.reason,
    quotationRef: row.quotation_ref,
    productionJobId: row.production_job_id,
    poId: row.po_id,
    coilLotRef: row.coil_lot_ref,
    approvalBeforeStart: Number(row.approval_before_start) === 1,
    status: row.status,
    createdByUserId: row.created_by_user_id,
    createdByName: row.created_by_name,
    createdAtIso: row.created_at_iso,
    updatedAtIso: row.updated_at_iso,
    submittedAtIso: row.submitted_at_iso,
    approvedByUserId: row.approved_by_user_id,
    approvedByName: row.approved_by_name,
    approvedAtIso: row.approved_at_iso,
    rejectedByUserId: row.rejected_by_user_id,
    rejectedByName: row.rejected_by_name,
    rejectedAtIso: row.rejected_at_iso,
    rejectionReason: row.rejection_reason,
    paidByUserId: row.paid_by_user_id,
    paidByName: row.paid_by_name,
    paidAtIso: row.paid_at_iso,
    paymentNote: row.payment_note,
    paymentMethod: row.payment_method,
    totalPayableNgn: Math.round(Number(row.total_payable_ngn) || 0),
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} requestId
 */
export function getOtRequest(db, requestId) {
  if (!tableReady(db)) return { ok: false, error: 'OT module not initialised.', code: 'OT_NOT_READY' };
  const id = String(requestId || '').trim();
  if (!id) return { ok: false, error: 'id is required.' };
  const row = db.prepare(`SELECT * FROM ot_requests WHERE id = ?`).get(id);
  if (!row) return { ok: false, error: 'OT request not found.', code: 'OT_NOT_FOUND' };

  const staff = db
    .prepare(
      `SELECT s.id, s.sort_order AS sortOrder, s.staff_user_id AS staffUserId, s.role_label AS roleLabel,
              s.start_time AS startTime, s.end_time AS endTime,
              u.display_name AS displayName, u.username
       FROM ot_staff_lines s
       LEFT JOIN app_users u ON u.id = s.staff_user_id
       WHERE s.request_id = ?
       ORDER BY s.sort_order ASC`
    )
    .all(id);

  const work = db
    .prepare(
      `SELECT material_type AS materialType, work_done AS workDone, quantity, quantity_unit AS quantityUnit,
              machine_area AS machineArea, actual_completion_time AS actualCompletionTime,
              factory_locked_by AS factoryLockedBy
       FROM ot_work_details WHERE request_id = ?`
    )
    .get(id);

  const payment = db
    .prepare(
      `SELECT category, quantity, rate_requested AS rateRequested, rate_approved AS rateApproved,
              amount_ngn AS amountNgn, remarks, variance_reason AS varianceReason
       FROM ot_payment_line WHERE request_id = ?`
    )
    .get(id);

  const history = db
    .prepare(
      `SELECT id, from_status AS fromStatus, to_status AS toStatus, actor_user_id AS actorUserId,
              actor_name AS actorName, actor_role AS actorRole, note, details_json AS detailsJson, at_iso AS atIso
       FROM ot_status_history WHERE request_id = ? ORDER BY at_iso ASC, id ASC`
    )
    .all(id)
    .map((h) => ({
      ...h,
      details: (() => {
        try {
          return h.detailsJson ? JSON.parse(h.detailsJson) : null;
        } catch {
          return null;
        }
      })(),
      detailsJson: undefined,
    }));

  return {
    ok: true,
    request: mapRequestRow(row),
    staffLines: staff,
    workDetails: work || null,
    paymentLine: payment || null,
    statusHistory: history,
  };
}

/**
 * List OT requests (caller applies status allow-list for role visibility).
 * @param {import('better-sqlite3').Database} db
 * @param {{ branchId?: string; status?: string | string[]; from?: string; to?: string; createdByUserId?: string; limit?: number }} opts
 */
export function listOtRequests(db, opts = {}) {
  if (!tableReady(db)) return [];
  const args = [];
  let sql = `SELECT * FROM ot_requests WHERE 1 = 1`;
  const branchId = String(opts.branchId || '').trim();
  if (branchId) {
    sql += ` AND branch_id = ?`;
    args.push(branchId);
  }
  if (opts.status != null) {
    const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
    const cleaned = statuses.map((s) => String(s || '').trim()).filter(Boolean);
    if (cleaned.length === 1) {
      sql += ` AND status = ?`;
      args.push(cleaned[0]);
    } else if (cleaned.length > 1) {
      sql += ` AND status IN (${cleaned.map(() => '?').join(',')})`;
      args.push(...cleaned);
    }
  }
  const from = normalizeDayIso(opts.from);
  if (from) {
    sql += ` AND day_iso >= ?`;
    args.push(from);
  }
  const to = normalizeDayIso(opts.to);
  if (to) {
    sql += ` AND day_iso <= ?`;
    args.push(to);
  }
  const createdBy = String(opts.createdByUserId || '').trim();
  if (createdBy) {
    sql += ` AND created_by_user_id = ?`;
    args.push(createdBy);
  }
  sql += ` ORDER BY day_iso DESC, created_at_iso DESC`;
  const limit = Math.min(500, Math.max(1, Math.round(Number(opts.limit) || 100)));
  sql += ` LIMIT ${limit}`;
  return db.prepare(sql).all(...args).map(mapRequestRow);
}

/**
 * Create draft OT request.
 * @param {import('better-sqlite3').Database} db
 * @param {object} actor
 * @param {object} body
 */
export function createOtRequest(db, actor, body = {}) {
  if (!tableReady(db)) return { ok: false, error: 'OT module not initialised.', code: 'OT_NOT_READY' };
  const branchId = String(body.branchId ?? body.branch_id ?? '').trim() || DEFAULT_BRANCH_ID;
  const dayIso = normalizeDayIso(body.dayIso ?? body.day_iso ?? body.date);
  if (!dayIso) return { ok: false, error: 'dayIso (YYYY-MM-DD) is required.', code: 'OT_DAY' };

  const workType = String(body.workType ?? body.work_type ?? '').trim();
  if (!OT_WORK_TYPES.includes(workType)) {
    return { ok: false, error: `workType must be one of: ${OT_WORK_TYPES.join(', ')}.`, code: 'OT_WORK_TYPE' };
  }

  const staffNorm = normalizeStaffLines(db, branchId, body.staffLines ?? body.staff_lines);
  if (!staffNorm.ok) return staffNorm;

  const payNorm = normalizePaymentLine(body.paymentLine ?? body.payment_line, { forSubmit: false });
  if (!payNorm.ok) return payNorm;

  const workDetails = normalizeWorkDetails(body.workDetails ?? body.work_details);
  const links = normalizeDomainLinks(workType, body);
  const reason = String(body.reason ?? '').trim() || null;
  const approvalBeforeStart =
    body.approvalBeforeStart === true ||
    body.approval_before_start === true ||
    Number(body.approvalBeforeStart ?? body.approval_before_start) === 1
      ? 1
      : 0;

  const id = nextOtRequestHumanId(db, branchId);
  const now = nowIso();
  const creatorId = actorId(actor);
  const creatorName = actorName(actor);

  try {
    db.transaction(() => {
      db.prepare(
        `INSERT INTO ot_requests (
          id, day_iso, branch_id, work_type, reason,
          quotation_ref, production_job_id, po_id, coil_lot_ref,
          approval_before_start, status,
          created_by_user_id, created_by_name, created_at_iso, updated_at_iso,
          total_payable_ngn
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
      ).run(
        id,
        dayIso,
        branchId,
        workType,
        reason,
        links.quotationRef,
        links.productionJobId,
        links.poId,
        links.coilLotRef,
        approvalBeforeStart,
        OT_STATUS.DRAFT,
        creatorId,
        creatorName,
        now,
        now,
        payNorm.line.amountNgn
      );
      replaceChildren(db, id, staffNorm.lines, workDetails, {
        ...payNorm.line,
        rateApproved: null,
        varianceReason: null,
      });
      appendStatusHistory(db, {
        requestId: id,
        fromStatus: null,
        toStatus: OT_STATUS.DRAFT,
        actor,
        note: 'Created',
      });
    })();
  } catch (e) {
    return { ok: false, error: e?.message || 'Could not create OT request.', code: 'OT_CREATE_FAILED' };
  }

  appendOtAudit(db, actor, 'ot_request.create', id, `Created draft ${id}`, { branchId, workType });
  return getOtRequest(db, id);
}

/**
 * Update draft only — creator only.
 */
export function updateOtRequest(db, actor, requestId, body = {}) {
  if (!tableReady(db)) return { ok: false, error: 'OT module not initialised.', code: 'OT_NOT_READY' };
  const id = String(requestId || '').trim();
  const row = db.prepare(`SELECT * FROM ot_requests WHERE id = ?`).get(id);
  if (!row) return { ok: false, error: 'OT request not found.', code: 'OT_NOT_FOUND' };
  if (String(row.status) !== OT_STATUS.DRAFT) {
    return {
      ok: false,
      error: 'Only draft OT requests can be edited.',
      code: 'OT_EDIT_STATUS',
      status: row.status,
    };
  }
  const actorUid = actorId(actor);
  if (actorUid && row.created_by_user_id && String(row.created_by_user_id) !== String(actorUid)) {
    return { ok: false, error: 'You can only edit OT requests you created.', code: 'OT_EDIT_OWNER' };
  }

  const branchId = String(body.branchId ?? body.branch_id ?? row.branch_id).trim();
  if (branchId !== String(row.branch_id)) {
    return { ok: false, error: 'Cannot change branch on an OT request.', code: 'OT_BRANCH_IMMUTABLE' };
  }

  const dayIso = normalizeDayIso(body.dayIso ?? body.day_iso ?? body.date ?? row.day_iso);
  if (!dayIso) return { ok: false, error: 'dayIso (YYYY-MM-DD) is required.', code: 'OT_DAY' };

  const workType = String(body.workType ?? body.work_type ?? row.work_type).trim();
  if (!OT_WORK_TYPES.includes(workType)) {
    return { ok: false, error: `workType must be one of: ${OT_WORK_TYPES.join(', ')}.`, code: 'OT_WORK_TYPE' };
  }

  const staffNorm = normalizeStaffLines(db, branchId, body.staffLines ?? body.staff_lines);
  if (!staffNorm.ok) return staffNorm;

  const payNorm = normalizePaymentLine(body.paymentLine ?? body.payment_line, { forSubmit: false });
  if (!payNorm.ok) return payNorm;

  const workDetails = normalizeWorkDetails(body.workDetails ?? body.work_details);
  const links = normalizeDomainLinks(workType, {
    ...body,
    quotationRef: body.quotationRef ?? body.quotation_ref ?? row.quotation_ref,
    productionJobId: body.productionJobId ?? body.production_job_id ?? row.production_job_id,
    poId: body.poId ?? body.po_id ?? row.po_id,
    coilLotRef: body.coilLotRef ?? body.coil_lot_ref ?? row.coil_lot_ref,
  });
  const reason =
    body.reason !== undefined ? String(body.reason ?? '').trim() || null : row.reason;
  const approvalBeforeStart =
    body.approvalBeforeStart !== undefined || body.approval_before_start !== undefined
      ? body.approvalBeforeStart === true ||
        body.approval_before_start === true ||
        Number(body.approvalBeforeStart ?? body.approval_before_start) === 1
        ? 1
        : 0
      : Number(row.approval_before_start) === 1
        ? 1
        : 0;

  const now = nowIso();
  try {
    db.transaction(() => {
      db.prepare(
        `UPDATE ot_requests SET
          day_iso = ?, work_type = ?, reason = ?,
          quotation_ref = ?, production_job_id = ?, po_id = ?, coil_lot_ref = ?,
          approval_before_start = ?, total_payable_ngn = ?, updated_at_iso = ?
         WHERE id = ? AND status = ?`
      ).run(
        dayIso,
        workType,
        reason,
        links.quotationRef,
        links.productionJobId,
        links.poId,
        links.coilLotRef,
        approvalBeforeStart,
        payNorm.line.amountNgn,
        now,
        id,
        OT_STATUS.DRAFT
      );
      replaceChildren(db, id, staffNorm.lines, workDetails, {
        ...payNorm.line,
        rateApproved: null,
        varianceReason: null,
      });
    })();
  } catch (e) {
    return { ok: false, error: e?.message || 'Could not update OT request.', code: 'OT_UPDATE_FAILED' };
  }

  appendOtAudit(db, actor, 'ot_request.update', id, `Updated draft ${id}`, { workType });
  return getOtRequest(db, id);
}

/**
 * draft → pending_bm_approval. Creator only; stricter completeness checks.
 */
export function submitOtRequest(db, actor, requestId, opts = {}) {
  if (!tableReady(db)) return { ok: false, error: 'OT module not initialised.', code: 'OT_NOT_READY' };
  const id = String(requestId || '').trim();
  const row = db.prepare(`SELECT * FROM ot_requests WHERE id = ?`).get(id);
  if (!row) return { ok: false, error: 'OT request not found.', code: 'OT_NOT_FOUND' };
  if (String(row.status) !== OT_STATUS.DRAFT) {
    return {
      ok: false,
      error: 'Only draft OT requests can be submitted.',
      code: 'OT_SUBMIT_STATUS',
      status: row.status,
    };
  }
  const scopeBranch = String(opts.branchId || '').trim();
  if (scopeBranch && scopeBranch !== String(row.branch_id)) {
    return { ok: false, error: 'OT request is outside your branch scope.', code: 'OT_BRANCH_SCOPE' };
  }
  const actorUid = actorId(actor);
  if (actorUid && row.created_by_user_id && String(row.created_by_user_id) !== String(actorUid)) {
    return { ok: false, error: 'You can only submit OT requests you created.', code: 'OT_SUBMIT_OWNER' };
  }

  const full = getOtRequest(db, id);
  if (!full.ok) return full;
  if (!full.staffLines?.length) {
    return { ok: false, error: 'Add at least one staff line before submit.', code: 'OT_STAFF_REQUIRED' };
  }
  if (!full.paymentLine) {
    return { ok: false, error: 'Payment line is required before submit.', code: 'OT_PAYMENT_REQUIRED' };
  }
  if (!(Number(full.paymentLine.quantity) > 0) || !(Number(full.paymentLine.rateRequested) > 0)) {
    return { ok: false, error: 'Payment quantity and rateRequested must be positive.', code: 'OT_PAYMENT_RATE' };
  }

  const links = {
    quotationRef: full.request.quotationRef,
    productionJobId: full.request.productionJobId,
    poId: full.request.poId,
    coilLotRef: full.request.coilLotRef,
  };
  const linkCheck = validateDomainLinksForSubmit(db, full.request.workType, links);
  if (!linkCheck.ok) return linkCheck;

  if (!String(full.request.reason || '').trim()) {
    return { ok: false, error: 'Reason is required before submit.', code: 'OT_REASON_REQUIRED' };
  }

  const now = nowIso();
  try {
    db.transaction(() => {
      const updated = db
        .prepare(
          `UPDATE ot_requests SET status = ?, submitted_at_iso = ?, updated_at_iso = ?
           WHERE id = ? AND status = ?`
        )
        .run(OT_STATUS.PENDING_BM, now, now, id, OT_STATUS.DRAFT);
      if (!updated.changes) throw new Error('Status changed concurrently.');
      appendStatusHistory(db, {
        requestId: id,
        fromStatus: OT_STATUS.DRAFT,
        toStatus: OT_STATUS.PENDING_BM,
        actor,
        note: 'Submitted for branch manager approval',
      });
    })();
  } catch (e) {
    return { ok: false, error: e?.message || 'Could not submit OT request.', code: 'OT_SUBMIT_FAILED' };
  }

  appendOtAudit(db, actor, 'ot_request.submit', id, `Submitted ${id}`, { branchId: row.branch_id });
  return getOtRequest(db, id);
}

/**
 * pending_bm_approval → approved_by_bm.
 * BM may set rateApproved; variance_reason required when rate differs from rate_requested.
 * @param {object} body
 * @param {number} [body.rateApproved]
 * @param {string} [body.varianceReason]
 */
export function approveOtRequest(db, actor, requestId, body = {}, opts = {}) {
  if (!tableReady(db)) return { ok: false, error: 'OT module not initialised.', code: 'OT_NOT_READY' };
  const id = String(requestId || '').trim();
  const row = db.prepare(`SELECT * FROM ot_requests WHERE id = ?`).get(id);
  if (!row) return { ok: false, error: 'OT request not found.', code: 'OT_NOT_FOUND' };
  if (String(row.status) !== OT_STATUS.PENDING_BM) {
    return {
      ok: false,
      error: 'Only pending_bm_approval requests can be approved.',
      code: 'OT_APPROVE_STATUS',
      status: row.status,
    };
  }
  const scopeBranch = String(opts.branchId || '').trim();
  if (scopeBranch && scopeBranch !== String(row.branch_id)) {
    return { ok: false, error: 'OT request is outside your branch scope.', code: 'OT_BRANCH_SCOPE' };
  }

  const pay = db.prepare(`SELECT * FROM ot_payment_line WHERE request_id = ?`).get(id);
  if (!pay) return { ok: false, error: 'Payment line missing.', code: 'OT_PAYMENT_REQUIRED' };

  const rateRequested = Math.round(Number(pay.rate_requested) || 0);
  let rateApproved =
    body.rateApproved !== undefined || body.rate_approved !== undefined
      ? moneyNgn(body.rateApproved ?? body.rate_approved)
      : rateRequested;
  if (rateApproved == null || rateApproved <= 0) {
    return { ok: false, error: 'rateApproved must be a positive ₦ amount.', code: 'OT_RATE_APPROVED' };
  }

  let varianceReason = String(body.varianceReason ?? body.variance_reason ?? '').trim() || null;
  if (rateApproved !== rateRequested) {
    if (!varianceReason || varianceReason.length < 3) {
      return {
        ok: false,
        error: 'varianceReason is required when rate_approved differs from rate_requested.',
        code: 'OT_VARIANCE_REASON',
      };
    }
  } else {
    varianceReason = null;
  }

  const quantity = Number(pay.quantity) || 0;
  const amountNgn = Math.round(quantity * rateApproved);
  const now = nowIso();
  const approverId = actorId(actor);
  const approverName = actorName(actor);

  try {
    db.transaction(() => {
      const updated = db
        .prepare(
          `UPDATE ot_requests SET
            status = ?, approved_by_user_id = ?, approved_by_name = ?, approved_at_iso = ?,
            total_payable_ngn = ?, updated_at_iso = ?
           WHERE id = ? AND status = ?`
        )
        .run(
          OT_STATUS.APPROVED,
          approverId,
          approverName,
          now,
          amountNgn,
          now,
          id,
          OT_STATUS.PENDING_BM
        );
      if (!updated.changes) throw new Error('Status changed concurrently.');
      db.prepare(
        `UPDATE ot_payment_line SET rate_approved = ?, amount_ngn = ?, variance_reason = ? WHERE request_id = ?`
      ).run(rateApproved, amountNgn, varianceReason, id);
      appendStatusHistory(db, {
        requestId: id,
        fromStatus: OT_STATUS.PENDING_BM,
        toStatus: OT_STATUS.APPROVED,
        actor,
        note: varianceReason
          ? `Approved with rate change: ${rateRequested} → ${rateApproved}`
          : 'Approved',
        details: {
          rateRequested,
          rateApproved,
          amountNgn,
          varianceReason,
        },
      });
    })();
  } catch (e) {
    return { ok: false, error: e?.message || 'Could not approve OT request.', code: 'OT_APPROVE_FAILED' };
  }

  appendOtAudit(db, actor, 'ot_request.approve', id, `Approved ${id}`, {
    rateRequested,
    rateApproved,
    amountNgn,
  });
  return getOtRequest(db, id);
}

/**
 * pending_bm_approval → rejected_by_bm (terminal).
 */
export function rejectOtRequest(db, actor, requestId, body = {}, opts = {}) {
  if (!tableReady(db)) return { ok: false, error: 'OT module not initialised.', code: 'OT_NOT_READY' };
  const id = String(requestId || '').trim();
  const row = db.prepare(`SELECT * FROM ot_requests WHERE id = ?`).get(id);
  if (!row) return { ok: false, error: 'OT request not found.', code: 'OT_NOT_FOUND' };
  if (String(row.status) !== OT_STATUS.PENDING_BM) {
    return {
      ok: false,
      error: 'Only pending_bm_approval requests can be rejected.',
      code: 'OT_REJECT_STATUS',
      status: row.status,
    };
  }
  const scopeBranch = String(opts.branchId || '').trim();
  if (scopeBranch && scopeBranch !== String(row.branch_id)) {
    return { ok: false, error: 'OT request is outside your branch scope.', code: 'OT_BRANCH_SCOPE' };
  }

  const reason = String(body.reason ?? body.rejectionReason ?? body.rejection_reason ?? '').trim();
  if (reason.length < 3) {
    return { ok: false, error: 'rejection reason is required (min 3 characters).', code: 'OT_REJECT_REASON' };
  }

  const now = nowIso();
  try {
    db.transaction(() => {
      const updated = db
        .prepare(
          `UPDATE ot_requests SET
            status = ?, rejected_by_user_id = ?, rejected_by_name = ?, rejected_at_iso = ?,
            rejection_reason = ?, updated_at_iso = ?
           WHERE id = ? AND status = ?`
        )
        .run(
          OT_STATUS.REJECTED,
          actorId(actor),
          actorName(actor),
          now,
          reason,
          now,
          id,
          OT_STATUS.PENDING_BM
        );
      if (!updated.changes) throw new Error('Status changed concurrently.');
      appendStatusHistory(db, {
        requestId: id,
        fromStatus: OT_STATUS.PENDING_BM,
        toStatus: OT_STATUS.REJECTED,
        actor,
        note: reason,
      });
    })();
  } catch (e) {
    return { ok: false, error: e?.message || 'Could not reject OT request.', code: 'OT_REJECT_FAILED' };
  }

  appendOtAudit(db, actor, 'ot_request.reject', id, `Rejected ${id}`, { reason });
  return getOtRequest(db, id);
}

/**
 * approved_by_bm → paid (mark paid only; no treasury posting in v1).
 *
 * Payable amount is locked at approve time:
 * - does not update ot_requests.total_payable_ngn
 * - does not update ot_payment_line rate_approved / amount_ngn
 * - ignores any amount/rate fields on the body (cashier cannot alter payables)
 */
export function payOtRequest(db, actor, requestId, body = {}, opts = {}) {
  if (!tableReady(db)) return { ok: false, error: 'OT module not initialised.', code: 'OT_NOT_READY' };
  const id = String(requestId || '').trim();
  const row = db.prepare(`SELECT * FROM ot_requests WHERE id = ?`).get(id);
  if (!row) return { ok: false, error: 'OT request not found.', code: 'OT_NOT_FOUND' };
  if (String(row.status) !== OT_STATUS.APPROVED) {
    return {
      ok: false,
      error: 'Only approved_by_bm requests can be marked paid.',
      code: 'OT_PAY_STATUS',
      status: row.status,
    };
  }
  const scopeBranch = String(opts.branchId || '').trim();
  if (scopeBranch && scopeBranch !== String(row.branch_id)) {
    return { ok: false, error: 'OT request is outside your branch scope.', code: 'OT_BRANCH_SCOPE' };
  }

  // Cashier mark-paid only — ignore any attempt to change the locked payable.
  const paymentNote = String(body.paymentNote ?? body.payment_note ?? '').trim() || null;
  const paymentMethod = String(body.paymentMethod ?? body.payment_method ?? '').trim() || null;
  const lockedPayableNgn = Math.round(Number(row.total_payable_ngn) || 0);
  const paymentBefore = db.prepare(`SELECT rate_approved, amount_ngn FROM ot_payment_line WHERE request_id = ?`).get(id);
  const now = nowIso();

  try {
    db.transaction(() => {
      const updated = db
        .prepare(
          `UPDATE ot_requests SET
            status = ?, paid_by_user_id = ?, paid_by_name = ?, paid_at_iso = ?,
            payment_note = ?, payment_method = ?, updated_at_iso = ?
           WHERE id = ? AND status = ?`
        )
        .run(
          OT_STATUS.PAID,
          actorId(actor),
          actorName(actor),
          now,
          paymentNote,
          paymentMethod,
          now,
          id,
          OT_STATUS.APPROVED
        );
      if (!updated.changes) throw new Error('Status changed concurrently.');
      appendStatusHistory(db, {
        requestId: id,
        fromStatus: OT_STATUS.APPROVED,
        toStatus: OT_STATUS.PAID,
        actor,
        note: paymentNote || 'Marked paid',
        details: {
          paymentMethod,
          totalPayableNgn: lockedPayableNgn,
        },
      });
    })();
  } catch (e) {
    return { ok: false, error: e?.message || 'Could not mark OT paid.', code: 'OT_PAY_FAILED' };
  }

  appendOtAudit(db, actor, 'ot_request.pay', id, `Paid ${id}`, {
    totalPayableNgn: lockedPayableNgn,
    paymentMethod,
  });

  const after = getOtRequest(db, id);
  // Defensive: payable must match pre-pay snapshot (approve-time lock).
  if (
    after.ok &&
    (after.request.totalPayableNgn !== lockedPayableNgn ||
      (paymentBefore &&
        (Number(after.paymentLine?.rateApproved) !== Number(paymentBefore.rate_approved) ||
          Number(after.paymentLine?.amountNgn) !== Number(paymentBefore.amount_ngn))))
  ) {
    return {
      ok: false,
      error: 'Payable amount integrity check failed after pay.',
      code: 'OT_PAY_AMOUNT_LOCKED',
    };
  }
  return after;
}

/**
 * Visibility helper for future API layer.
 * @param {'storekeeper'|'branch_manager'|'cashier'|'admin'} roleView
 */
export function statusesForRoleView(roleView) {
  switch (String(roleView || '').trim()) {
    case 'storekeeper':
      return null; // all for own branch; prefer filter by createdByUserId for drafts UX
    case 'branch_manager':
      return null; // BM may see branch history; actionable = pending
    case 'cashier':
      return [...OT_CASHIER_VISIBLE_STATUSES];
    default:
      return null;
  }
}
