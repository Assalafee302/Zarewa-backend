/**
 * Second-party approval for sensitive PATCH (edit) operations.
 * Exempt roles: admin, md. Everyone else must obtain an approved token (single-use) per edit.
 */
import { editMutationRequiresSecondApproval, userCanApproveEditMutations } from './auth.js';
import { appendAuditLog } from './controlOps.js';
import { hasColumn } from './ap2ReceivedBasisOps.js';

function formatNgnContext(n) {
  const v = Math.round(Number(n) || 0);
  return `₦${v.toLocaleString('en-NG')}`;
}

function editApprovalTableHasColumn(db, col) {
  return hasColumn(db, 'edit_approval_tokens', col);
}

function normalizeChangeDetailsInput(raw) {
  if (raw == null) return [];
  let arr = raw;
  if (typeof raw === 'string') {
    try {
      arr = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const row of arr) {
    if (!row || typeof row !== 'object') continue;
    const label = String(row.label ?? row.field ?? row.key ?? '').trim();
    if (!label) continue;
    const from = row.from != null ? String(row.from) : row.before != null ? String(row.before) : '';
    const to = row.to != null ? String(row.to) : row.after != null ? String(row.after) : '';
    out.push({ label, from, to });
  }
  return out;
}

function serializeChangeDetails(details) {
  const rows = normalizeChangeDetailsInput(details);
  return rows.length ? JSON.stringify(rows) : '';
}

export function ensureEditApprovalTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS edit_approval_tokens (
      id TEXT PRIMARY KEY,
      entity_kind TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      branch_id TEXT NOT NULL DEFAULT '',
      requested_by_user_id TEXT NOT NULL,
      requested_by_display TEXT,
      requested_at_iso TEXT NOT NULL,
      approved_by_user_id TEXT,
      approved_by_display TEXT,
      approved_at_iso TEXT,
      used_at_iso TEXT,
      expires_at_iso TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_edit_approval_status ON edit_approval_tokens (status, requested_at_iso)`);
  if (editApprovalTableHasColumn(db, 'id')) {
    if (!editApprovalTableHasColumn(db, 'change_summary')) {
      db.exec(`ALTER TABLE edit_approval_tokens ADD COLUMN change_summary TEXT`);
    }
    if (!editApprovalTableHasColumn(db, 'change_details_json')) {
      db.exec(`ALTER TABLE edit_approval_tokens ADD COLUMN change_details_json TEXT`);
    }
  }
}

/**
 * Human-friendly single-use token (6 digits). Retries on collision; falls back to legacy EA-… if needed.
 * @param {import('better-sqlite3').Database} db
 */
function newApprovalId(db) {
  ensureEditApprovalTable(db);
  const taken = db.prepare('SELECT 1 AS x FROM edit_approval_tokens WHERE id = ?');
  for (let i = 0; i < 80; i++) {
    const n = Math.floor(100000 + Math.random() * 900000);
    const id = String(n);
    if (!taken.get(id)) return id;
  }
  return `EA-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function mapApprovalRow(row) {
  if (!row) return null;
  const changeDetails = normalizeChangeDetailsInput(row.change_details_json);
  return {
    id: row.id,
    entityKind: row.entity_kind,
    entityId: row.entity_id,
    branchId: row.branch_id ?? '',
    requestedByUserId: row.requested_by_user_id,
    requestedByDisplay: row.requested_by_display ?? '',
    requestedAtISO: row.requested_at_iso,
    approvedByUserId: row.approved_by_user_id ?? '',
    approvedByDisplay: row.approved_by_display ?? '',
    approvedAtISO: row.approved_at_iso ?? '',
    usedAtISO: row.used_at_iso ?? '',
    expiresAtISO: row.expires_at_iso ?? '',
    status: row.status,
    changeSummary: String(row.change_summary || '').trim(),
    changeDetails,
  };
}

/**
 * Snapshot of the target record so approvers can see what is being edited.
 * @param {import('better-sqlite3').Database} db
 */
export function buildEditApprovalRecordContext(db, entityKind, entityId) {
  const ek = String(entityKind || '').trim().toLowerCase();
  const eid = String(entityId || '').trim();
  if (!ek || !eid) {
    return { entityLabel: '', headline: '', fields: [] };
  }

  const field = (label, value) => ({ label, value: value == null || value === '' ? '—' : String(value) });

  if (ek === 'quotation') {
    const q = db
      .prepare(
        `SELECT id, customer_name, status, total_ngn, paid_ngn, project_name, date_iso
         FROM quotations WHERE id = ?`
      )
      .get(eid);
    if (!q) return { entityLabel: 'Quotation', headline: eid, fields: [field('Reference', eid)] };
    return {
      entityLabel: 'Quotation',
      headline: `${q.customer_name || '—'} · ${q.id}`,
      fields: [
        field('Customer', q.customer_name),
        field('Status', q.status),
        field('Total', formatNgnContext(q.total_ngn)),
        field('Paid', formatNgnContext(q.paid_ngn)),
        field('Project', q.project_name),
        field('Date', String(q.date_iso || '').slice(0, 10)),
      ],
    };
  }

  if (ek === 'purchase_order') {
    const po = db
      .prepare(
        `SELECT po_id, supplier_name, status, order_date_iso, expected_delivery_iso, total_ngn
         FROM purchase_orders WHERE po_id = ?`
      )
      .get(eid);
    if (!po) return { entityLabel: 'Purchase order', headline: eid, fields: [field('PO', eid)] };
    return {
      entityLabel: 'Purchase order',
      headline: `${po.supplier_name || '—'} · ${po.po_id}`,
      fields: [
        field('Supplier', po.supplier_name),
        field('Status', po.status),
        field('Order date', String(po.order_date_iso || '').slice(0, 10)),
        field('Expected delivery', String(po.expected_delivery_iso || '').slice(0, 10)),
        field('Total', formatNgnContext(po.total_ngn)),
      ],
    };
  }

  if (ek === 'production_job') {
    const job = db
      .prepare(
        `SELECT job_id, quotation_ref, customer_name, product_name, status, actual_meters
         FROM production_jobs WHERE job_id = ?`
      )
      .get(eid);
    if (!job) return { entityLabel: 'Production job', headline: eid, fields: [field('Job', eid)] };
    return {
      entityLabel: 'Production job',
      headline: `${job.quotation_ref || '—'} · ${job.job_id}`,
      fields: [
        field('Quotation', job.quotation_ref),
        field('Customer', job.customer_name),
        field('Product', job.product_name),
        field('Status', job.status),
        field('Actual metres', job.actual_meters),
      ],
    };
  }

  if (ek === 'cutting_list') {
    const cl = db
      .prepare(`SELECT id, quotation_ref, customer_name, status, date_iso FROM cutting_lists WHERE id = ?`)
      .get(eid);
    if (!cl) return { entityLabel: 'Cutting list', headline: eid, fields: [field('Cutting list', eid)] };
    return {
      entityLabel: 'Cutting list',
      headline: `${cl.quotation_ref || '—'} · ${cl.id}`,
      fields: [
        field('Quotation', cl.quotation_ref),
        field('Customer', cl.customer_name),
        field('Status', cl.status),
        field('Date', String(cl.date_iso || '').slice(0, 10)),
      ],
    };
  }

  if (ek === 'sales_receipt') {
    const rec = db
      .prepare(
        `SELECT id, customer_name, quotation_ref, amount_ngn, status, date_iso, payment_method
         FROM sales_receipts WHERE id = ?`
      )
      .get(eid);
    if (!rec) return { entityLabel: 'Sales receipt', headline: eid, fields: [field('Receipt', eid)] };
    return {
      entityLabel: 'Sales receipt',
      headline: `${rec.customer_name || '—'} · ${rec.id}`,
      fields: [
        field('Customer', rec.customer_name),
        field('Quotation', rec.quotation_ref),
        field('Amount', formatNgnContext(rec.amount_ngn)),
        field('Status', rec.status),
        field('Payment method', rec.payment_method),
        field('Date', String(rec.date_iso || '').slice(0, 10)),
      ],
    };
  }

  if (ek === 'user') {
    const u = db.prepare(`SELECT id, username, display_name, role_key FROM users WHERE id = ?`).get(eid);
    if (!u) return { entityLabel: 'User account', headline: eid, fields: [field('User', eid)] };
    return {
      entityLabel: 'User account',
      headline: u.display_name || u.username || eid,
      fields: [
        field('Display name', u.display_name || u.username),
        field('Username', u.username),
        field('Role', u.role_key),
      ],
    };
  }

  const label = ek.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return { entityLabel: label, headline: eid, fields: [field('Record ID', eid)] };
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function getEditApprovalDetail(db, approvalId) {
  const approval = getEditApproval(db, approvalId);
  if (!approval) return null;
  const recordContext = buildEditApprovalRecordContext(db, approval.entityKind, approval.entityId);
  return { ...approval, recordContext };
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function createEditApprovalRequest(
  db,
  { entityKind, entityId, branchId = '', actor, changeSummary = '', changeDetails = null }
) {
  ensureEditApprovalTable(db);
  const ek = String(entityKind || '').trim();
  const eid = String(entityId || '').trim();
  if (!ek || !eid) return { ok: false, error: 'entityKind and entityId are required.' };
  const bid = String(branchId || '').trim();
  const uid = String(actor?.id ?? '').trim();
  const summary = String(changeSummary || '').trim();
  const detailsJson = serializeChangeDetails(changeDetails);
  const existing = db
    .prepare(
      `SELECT id FROM edit_approval_tokens
       WHERE entity_kind = ? AND entity_id = ? AND branch_id = ? AND requested_by_user_id = ? AND status = 'pending'
       ORDER BY requested_at_iso DESC LIMIT 1`
    )
    .get(ek, eid, bid, uid);
  if (existing?.id) {
    if (summary || detailsJson) {
      db.prepare(
        `UPDATE edit_approval_tokens
         SET change_summary = COALESCE(NULLIF(?, ''), change_summary),
             change_details_json = COALESCE(NULLIF(?, ''), change_details_json)
         WHERE id = ? AND status = 'pending'`
      ).run(summary, detailsJson, String(existing.id));
    }
    return {
      ok: false,
      code: 'EDIT_APPROVAL_ALREADY_PENDING',
      error:
        'You already have a pending approval request for this record. Wait for your approver (or enter the code when they approve it). A second request was not created.',
      existingApprovalId: String(existing.id),
    };
  }
  const id = newApprovalId(db);
  const now = new Date().toISOString();
  const disp = String(actor?.displayName ?? actor?.username ?? '').trim();
  db.prepare(
    `INSERT INTO edit_approval_tokens (
      id, entity_kind, entity_id, branch_id, requested_by_user_id, requested_by_display,
      requested_at_iso, status, change_summary, change_details_json
    ) VALUES (?,?,?,?,?,?,?,'pending',?,?)`
  ).run(id, ek, eid, bid, uid, disp, now, summary, detailsJson);
  appendAuditLog(db, {
    actor,
    action: 'edit_approval.requested',
    entityKind: ek,
    entityId: eid,
    note: id,
    details: { approvalId: id },
  });
  return { ok: true, approvalId: id, status: 'pending' };
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function approveEditApproval(db, { approvalId, actor }) {
  ensureEditApprovalTable(db);
  if (!userCanApproveEditMutations(actor)) {
    return { ok: false, error: 'Only an administrator or designated manager can approve edit requests.' };
  }
  const aid = String(approvalId || '').trim();
  const row = db.prepare(`SELECT * FROM edit_approval_tokens WHERE id = ?`).get(aid);
  if (!row) return { ok: false, error: 'Approval request not found.' };
  if (row.status !== 'pending') return { ok: false, error: 'This request is no longer pending.' };
  const rid = String(row.requested_by_user_id || '').trim();
  const approverId = String(actor?.id ?? '').trim();
  if (rid && approverId && rid === approverId) {
    return { ok: false, error: 'You cannot approve your own edit request (two-person control).' };
  }
  const now = new Date().toISOString();
  const exp = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const disp = String(actor?.displayName ?? actor?.username ?? '').trim();
  db.prepare(
    `UPDATE edit_approval_tokens
     SET status = 'approved', approved_by_user_id = ?, approved_by_display = ?, approved_at_iso = ?, expires_at_iso = ?
     WHERE id = ? AND status = 'pending'`
  ).run(approverId, disp, now, exp, aid);
  appendAuditLog(db, {
    actor,
    action: 'edit_approval.approved',
    entityKind: row.entity_kind,
    entityId: row.entity_id,
    note: aid,
    details: { approvalId: aid, expiresAtISO: exp },
  });
  return { ok: true, approvalId: aid, status: 'approved', expiresAtISO: exp };
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function rejectEditApproval(db, { approvalId, actor, reason = '' }) {
  ensureEditApprovalTable(db);
  if (!userCanApproveEditMutations(actor)) {
    return { ok: false, error: 'Only an administrator or designated manager can reject edit requests.' };
  }
  const aid = String(approvalId || '').trim();
  const row = db.prepare(`SELECT * FROM edit_approval_tokens WHERE id = ?`).get(aid);
  if (!row) return { ok: false, error: 'Approval request not found.' };
  if (row.status !== 'pending') return { ok: false, error: 'This request is no longer pending.' };
  const rid = String(row.requested_by_user_id || '').trim();
  const approverId = String(actor?.id ?? '').trim();
  if (rid && approverId && rid === approverId) {
    return { ok: false, error: 'You cannot reject your own edit request (two-person control).' };
  }
  const now = new Date().toISOString();
  const disp = String(actor?.displayName ?? actor?.username ?? '').trim();
  const note = String(reason || '').trim() || 'Rejected by approver.';
  db.prepare(
    `UPDATE edit_approval_tokens
     SET status = 'rejected', approved_by_user_id = ?, approved_by_display = ?, approved_at_iso = ?
     WHERE id = ? AND status = 'pending'`
  ).run(approverId, disp, now, aid);
  appendAuditLog(db, {
    actor,
    action: 'edit_approval.rejected',
    entityKind: row.entity_kind,
    entityId: row.entity_id,
    note,
    details: { approvalId: aid },
  });
  return { ok: true, approvalId: aid, status: 'rejected' };
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function getEditApproval(db, approvalId) {
  ensureEditApprovalTable(db);
  const row = db.prepare(`SELECT * FROM edit_approval_tokens WHERE id = ?`).get(String(approvalId || '').trim());
  return mapApprovalRow(row);
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function listPendingEditApprovals(db, limit = 100) {
  ensureEditApprovalTable(db);
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 500);
  const rows = db
    .prepare(
      `SELECT * FROM edit_approval_tokens WHERE status = 'pending' ORDER BY requested_at_iso DESC LIMIT ?`
    )
    .all(lim);
  return rows.map(mapApprovalRow);
}

/**
 * Must run inside an outer db.transaction() together with the mutating write.
 * @param {import('better-sqlite3').Database} db
 */
export function consumeEditApprovalInTransaction(db, approvalId, entityKind, entityId) {
  ensureEditApprovalTable(db);
  const aid = String(approvalId || '').trim();
  const ek = String(entityKind || '').trim();
  const eid = String(entityId || '').trim();
  const nowIso = new Date().toISOString();
  const r = db
    .prepare(
      `UPDATE edit_approval_tokens
       SET status = 'used', used_at_iso = ?
       WHERE id = ?
         AND status = 'approved'
         AND entity_kind = ?
         AND entity_id = ?
         AND (expires_at_iso IS NULL OR expires_at_iso > ?)`
    )
    .run(nowIso, aid, ek, eid, nowIso);
  if (r.changes !== 1) {
    throw new Error(
      'Invalid, expired, already used, or mismatched edit approval. Request a new approval from a manager or administrator.'
    );
  }
}

export function stripEditApprovalFromBody(body) {
  if (!body || typeof body !== 'object') return body;
  const { editApprovalId: _e, ...rest } = body;
  return rest;
}

/** @param {import('better-sqlite3').Database} db */
export function salesReceiptReconciliationIsFinalized(db, receiptId) {
  const id = String(receiptId || '').trim();
  if (!id) return false;
  const row = db
    .prepare(`SELECT finance_reconciliation_saved_at_iso FROM sales_receipts WHERE id = ?`)
    .get(id);
  return (
    row?.finance_reconciliation_saved_at_iso != null &&
    String(row.finance_reconciliation_saved_at_iso).trim() !== ''
  );
}

/** True when quotation has at least one non-reversed sales receipt (payment on file). */
export function quotationHasActiveSalesReceipts(db, quotationRef) {
  const qid = String(quotationRef || '').trim();
  if (!qid) return false;
  const row = db
    .prepare(
      `SELECT COUNT(*) AS c FROM sales_receipts
       WHERE quotation_ref = ?
         AND (status IS NULL OR TRIM(LOWER(status)) NOT IN ('reversed'))`
    )
    .get(qid);
  return Number(row?.c) > 0;
}

/**
 * Quotation PATCH: open edit while no receipts exist; require manager token once payments are posted.
 * @param {import('better-sqlite3').Database} db
 */
export function quotationEditRequiresEditApproval(db, user, quotationId) {
  if (!editMutationRequiresSecondApproval(user)) return false;
  return quotationHasActiveSalesReceipts(db, quotationId);
}

/** True when the cutting list has been sent to the production queue. */
export function cuttingListIsPushedToProduction(db, cuttingListId) {
  const id = String(cuttingListId || '').trim();
  if (!id) return false;
  const row = db.prepare(`SELECT production_registered FROM cutting_lists WHERE id = ?`).get(id);
  return Number(row?.production_registered) > 0;
}

/**
 * Cutting list PATCH: open edit while still waiting; require manager token once pushed to production.
 * @param {import('better-sqlite3').Database} db
 */
export function cuttingListEditRequiresEditApproval(db, user, cuttingListId) {
  if (!editMutationRequiresSecondApproval(user)) return false;
  return cuttingListIsPushedToProduction(db, cuttingListId);
}

/**
 * Receipt finance settlement (first reconcile or revision) is open to Finance/Cashier — no second-party token.
 * @param {import('better-sqlite3').Database} db
 */
export function receiptFinanceSettlementRequiresEditApproval(_db, _user, _receiptId) {
  return false;
}

/**
 * Ledger receipt treasury corrections tied to sales receipts follow open settlement edit policy.
 * Other treasury movement corrections still use the default second-party gate.
 * @param {import('better-sqlite3').Database} db
 */
export function ledgerReceiptMovementRevisionRequiresEditApproval(db, user, movementId) {
  const mid = String(movementId || '').trim();
  if (!mid) return false;
  const row = db
    .prepare(`SELECT source_id, type, source_kind FROM treasury_movements WHERE id = ?`)
    .get(mid);
  if (!row || String(row.type) !== 'RECEIPT_IN' || String(row.source_kind) !== 'LEDGER_RECEIPT') {
    return editMutationRequiresSecondApproval(user);
  }
  return false;
}

/**
 * Expense / payment pay-from corrections are open to Finance — no second-party token.
 * @param {import('better-sqlite3').Database} db
 */
export function expenseOutflowCorrectionRequiresEditApproval(_db, _user, _movementId) {
  return false;
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {object} user
 * @param {string} entityId
 * @param {{ requiresEditApproval?: (db: import('better-sqlite3').Database, user: object, entityId: string) => boolean }} [options]
 */
function patchNeedsEditApprovalToken(db, user, entityId, options = {}) {
  if (typeof options.requiresEditApproval === 'function') {
    return options.requiresEditApproval(db, user, entityId);
  }
  return editMutationRequiresSecondApproval(user);
}

/**
 * Shared guard for PATCH/POST bodies that carry `editApprovalId` (single-use token for non-exempt roles).
 * @param {import('express').Response} res
 * @param {import('better-sqlite3').Database} db
 * @param {object} user req.user
 * @param {object} body req.body
 * @param {string} entityKind
 * @param {string} entityId
 * @param {(strippedBody: object, ctx?: { withinEditApprovalTransaction?: boolean }) => { ok: boolean, error?: string, code?: string }} executeWrite — sync; when ctx.withinEditApprovalTransaction is true, avoid opening nested db.transaction in the callee (MySQL SAVEPOINT stack).
 */
export function handleWriteWithEditApproval(res, db, user, body, entityKind, entityId, executeWrite) {
  const stripped = stripEditApprovalFromBody(body || {});
  const runWrite = () => {
    const out = executeWrite(stripped, { withinEditApprovalTransaction: true });
    if (!out || out.ok === false) {
      if (out && out.code === 'PRODUCTION_SPEC_MISMATCH') {
        const err = new Error(out.error || 'Spec mismatch');
        err.__clientJson = {
          ok: false,
          code: out.code,
          error: out.error,
          mismatches: out.mismatches,
        };
        throw err;
      }
      throw new Error(out?.error || 'Update rejected.');
    }
    return out;
  };
  if (!editMutationRequiresSecondApproval(user)) {
    try {
      const r = db.transaction(runWrite)();
      if (!r.ok && (r.code === 'DUPLICATE_CUSTOMER_REGISTRATION' || r.code === 'DUPLICATE_SUPPLIER_REGISTRATION'))
        return res.status(409).json(r);
      return res.status(200).json(r);
    } catch (e) {
      if (e && e.__clientJson) return res.status(400).json(e.__clientJson);
      return res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  }
  const aid = String(body?.editApprovalId ?? '').trim();
  if (!aid) {
    return res.status(403).json({
      ok: false,
      code: 'EDIT_APPROVAL_REQUIRED',
      error:
        'A manager or administrator must approve this change first. Request an approval (Procurement / quotation save panel, or POST /api/edit-approvals/request), have them approve it on the Manager dashboard, then enter the 6-digit code and retry.',
    });
  }
  try {
    const r = db.transaction(() => {
      consumeEditApprovalInTransaction(db, aid, entityKind, entityId);
      return runWrite();
    })();
    if (!r.ok && (r.code === 'DUPLICATE_CUSTOMER_REGISTRATION' || r.code === 'DUPLICATE_SUPPLIER_REGISTRATION'))
      return res.status(409).json(r);
    return res.status(200).json(r);
  } catch (e) {
    if (e && e.__clientJson) return res.status(400).json(e.__clientJson);
    return res.status(400).json({ ok: false, error: String(e.message || e) });
  }
}

/**
 * @param {import('express').Response} res
 * @param {import('better-sqlite3').Database} db
 * @param {object} user req.user
 * @param {object} body req.body
 * @param {string} entityKind
 * @param {string} entityId
 * @param {(strippedBody: object, ctx?: { withinEditApprovalTransaction?: boolean }) => { ok: boolean, error?: string, code?: string }} executeWrite — sync; pass ctx.withinEditApprovalTransaction true when callee must not nest db.transaction (edit-approval outer tx on MySQL).
 */
export function handlePatchWithEditApproval(res, db, user, body, entityKind, entityId, executeWrite, options = {}) {
  const stripped = stripEditApprovalFromBody(body || {});
  if (!patchNeedsEditApprovalToken(db, user, entityId, options)) {
    const r = executeWrite(stripped, { withinEditApprovalTransaction: false });
    if (!r.ok && (r.code === 'DUPLICATE_CUSTOMER_REGISTRATION' || r.code === 'DUPLICATE_SUPPLIER_REGISTRATION'))
      return res.status(409).json(r);
    return res.status(r.ok ? 200 : 400).json(r);
  }
  const aid = String(body?.editApprovalId ?? '').trim();
  if (!aid) {
    const receiptRevision =
      entityKind === 'sales_receipt' &&
      typeof options.requiresEditApproval === 'function' &&
      salesReceiptReconciliationIsFinalized(db, entityId);
    return res.status(403).json({
      ok: false,
      code: 'EDIT_APPROVAL_REQUIRED',
      error: receiptRevision
        ? 'This receipt was already reconciled once. A manager must approve before you can change it again — request approval, then enter the 6-digit code and retry.'
        : 'A manager or administrator must approve this change first. Request an approval (Procurement / quotation save panel, or POST /api/edit-approvals/request), have them approve it on the Manager dashboard, then enter the 6-digit code and retry.',
    });
  }
  try {
    const r = db.transaction(() => {
      consumeEditApprovalInTransaction(db, aid, entityKind, entityId);
      const out = executeWrite(stripped, { withinEditApprovalTransaction: true });
      if (!out || out.ok === false) throw new Error(out?.error || 'Update rejected.');
      return out;
    })();
    if (!r.ok && (r.code === 'DUPLICATE_CUSTOMER_REGISTRATION' || r.code === 'DUPLICATE_SUPPLIER_REGISTRATION'))
      return res.status(409).json(r);
    return res.status(200).json(r);
  } catch (e) {
    return res.status(400).json({ ok: false, error: String(e.message || e) });
  }
}

/**
 * Quotations PATCH returns `{ ok: true, quotation, autoOverpayAppliedNgn }` (`autoOverpayAppliedNgn` is the amount
 * of split-till overpay **re-applied** after each save's internal reconcile; 0 when nothing applied).
 */
function quotationPatchResultPayload(result) {
  if (result && typeof result === 'object' && result.quotation != null) {
    return {
      quotation: result.quotation,
      autoOverpayAppliedNgn: Number(result.autoOverpayAppliedNgn) || 0,
    };
  }
  return { quotation: result, autoOverpayAppliedNgn: 0 };
}

export function handlePatchWithEditApprovalQuotation(res, db, user, body, quotationId, executeWrite) {
  const stripped = stripEditApprovalFromBody(body || {});
  if (!quotationEditRequiresEditApproval(db, user, quotationId)) {
    try {
      const { quotation, autoOverpayAppliedNgn } = quotationPatchResultPayload(executeWrite(stripped));
      return res.json({ ok: true, quotation, autoOverpayAppliedNgn });
    } catch (e) {
      if (e?.statusCode === 422 && e?.code) {
        return res.status(422).json({
          ok: false,
          error: String(e.message || ''),
          code: e.code,
          details: e.details,
        });
      }
      return res.status(400).json({ ok: false, error: String(e.message || e) });
    }
  }
  const aid = String(body?.editApprovalId ?? '').trim();
  if (!aid) {
    const hasReceipts = quotationHasActiveSalesReceipts(db, quotationId);
    return res.status(403).json({
      ok: false,
      code: 'EDIT_APPROVAL_REQUIRED',
      error: hasReceipts
        ? 'This quotation has payment receipts on file. A manager must approve before you can change it — request approval, then enter the 6-digit code and retry.'
        : 'A manager or administrator must approve this change first. Request an approval, then retry with the 6-digit approval code.',
    });
  }
  try {
    const raw = db.transaction(() => {
      consumeEditApprovalInTransaction(db, aid, 'quotation', String(quotationId).trim());
      return executeWrite(stripped);
    })();
    const { quotation, autoOverpayAppliedNgn } = quotationPatchResultPayload(raw);
    return res.json({ ok: true, quotation, autoOverpayAppliedNgn });
  } catch (e) {
    if (e?.statusCode === 422 && e?.code) {
      return res.status(422).json({
        ok: false,
        error: String(e.message || ''),
        code: e.code,
        details: e.details,
      });
    }
    return res.status(400).json({ ok: false, error: String(e.message || e) });
  }
}
