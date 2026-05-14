/**
 * Second-party approval for sensitive PATCH (edit) operations.
 * Exempt roles: admin, md. Everyone else must obtain an approved token (single-use) per edit.
 */
import { editMutationRequiresSecondApproval, userCanApproveEditMutations } from './auth.js';
import { appendAuditLog } from './controlOps.js';

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
  };
}

/**
 * @param {import('better-sqlite3').Database} db
 */
export function createEditApprovalRequest(db, { entityKind, entityId, branchId = '', actor }) {
  ensureEditApprovalTable(db);
  const ek = String(entityKind || '').trim();
  const eid = String(entityId || '').trim();
  if (!ek || !eid) return { ok: false, error: 'entityKind and entityId are required.' };
  const bid = String(branchId || '').trim();
  const uid = String(actor?.id ?? '').trim();
  const existing = db
    .prepare(
      `SELECT id FROM edit_approval_tokens
       WHERE entity_kind = ? AND entity_id = ? AND branch_id = ? AND requested_by_user_id = ? AND status = 'pending'
       ORDER BY requested_at_iso DESC LIMIT 1`
    )
    .get(ek, eid, bid, uid);
  if (existing?.id) {
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
      requested_at_iso, status
    ) VALUES (?,?,?,?,?,?,?,'pending')`
  ).run(id, ek, eid, bid, uid, disp, now);
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
      if (!r.ok && r.code === 'DUPLICATE_CUSTOMER_REGISTRATION') return res.status(409).json(r);
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
    if (!r.ok && r.code === 'DUPLICATE_CUSTOMER_REGISTRATION') return res.status(409).json(r);
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
export function handlePatchWithEditApproval(res, db, user, body, entityKind, entityId, executeWrite) {
  const stripped = stripEditApprovalFromBody(body || {});
  if (!editMutationRequiresSecondApproval(user)) {
    const r = executeWrite(stripped, { withinEditApprovalTransaction: false });
    if (!r.ok && r.code === 'DUPLICATE_CUSTOMER_REGISTRATION') return res.status(409).json(r);
    return res.status(r.ok ? 200 : 400).json(r);
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
      const out = executeWrite(stripped, { withinEditApprovalTransaction: true });
      if (!out || out.ok === false) throw new Error(out?.error || 'Update rejected.');
      return out;
    })();
    if (!r.ok && r.code === 'DUPLICATE_CUSTOMER_REGISTRATION') return res.status(409).json(r);
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
  if (!editMutationRequiresSecondApproval(user)) {
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
    return res.status(403).json({
      ok: false,
      code: 'EDIT_APPROVAL_REQUIRED',
      error:
        'A manager or administrator must approve this change first. Request an approval, then retry with the 6-digit approval code.',
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
