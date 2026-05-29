import { computeOfficeApprovalRoute } from '../shared/lib/officeApprovalRouting.js';
import { isBranchExpenseApproverRoleKey } from '../shared/workspaceGovernance.js';

/**
 * @param {import('better-sqlite3').Database} db
 */
export function officeRecordVersionsReady(db) {
  try {
    return db.prepare(`SELECT 1 FROM office_record_versions LIMIT 1`).get() != null;
  } catch {
    return false;
  }
}

/**
 * Branch manager may edit body before endorsement.
 * @param {object} threadRow
 * @param {object} actor
 */
export function canBranchManagerEditOfficeRecord(threadRow, actor) {
  if (!threadRow || !actor) return false;
  if (!isBranchExpenseApproverRoleKey(actor.roleKey)) return false;
  const st = String(threadRow.status || '').toLowerCase();
  if (/endorsed|approved|converted|filed|closed/.test(st)) return false;
  return st === 'open' || st === 'submitted' || st === 'pending';
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} threadId
 * @param {object} actor
 * @param {{ subject?: string; body?: string; editReason?: string }} patch
 */
export function patchOfficeRecordByBranchManager(db, threadId, actor, patch = {}) {
  const tid = String(threadId || '').trim();
  const row = db.prepare(`SELECT * FROM office_threads WHERE id = ?`).get(tid);
  if (!row) return { ok: false, error: 'Office record not found.' };
  if (!canBranchManagerEditOfficeRecord(row, actor)) {
    return { ok: false, error: 'This record can no longer be edited. Add a comment or return for correction.' };
  }

  const prevSubject = String(row.subject || '');
  const prevBody = String(row.body || '');
  const nextSubject = patch.subject != null ? String(patch.subject).trim() : prevSubject;
  const nextBody = patch.body != null ? String(patch.body).trim() : prevBody;

  if (officeRecordVersionsReady(db)) {
    db.prepare(
      `INSERT INTO office_record_versions (id, thread_id, subject, body, edited_by_user_id, edited_by_display, edit_reason, created_at_iso)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      `ORV-${tid}-${Date.now()}`,
      tid,
      prevSubject,
      prevBody,
      actor.id,
      actor.displayName || actor.username,
      String(patch.editReason || '').trim() || null,
      new Date().toISOString()
    );
  }

  let payload = {};
  try {
    payload = row.payload_json ? JSON.parse(row.payload_json) : {};
  } catch {
    payload = {};
  }
  payload.editedByBranchManager = true;
  payload.lastEditedAtIso = new Date().toISOString();
  payload.lastEditedByUserId = actor.id;

  db.prepare(
    `UPDATE office_threads SET subject = ?, body = ?, payload_json = ?, updated_at_iso = ? WHERE id = ?`
  ).run(nextSubject, nextBody, JSON.stringify(payload), new Date().toISOString(), tid);

  return { ok: true, threadId: tid, subject: nextSubject, body: nextBody };
}

/**
 * @param {import('better-sqlite3').Database} db
 * @param {string} threadId
 */
export function listOfficeRecordVersions(db, threadId) {
  if (!officeRecordVersionsReady(db)) return [];
  return db
    .prepare(
      `SELECT id, subject, body, edited_by_display AS editedByDisplay, edit_reason AS editReason, created_at_iso AS createdAtIso
       FROM office_record_versions WHERE thread_id = ? ORDER BY created_at_iso ASC`
    )
    .all(String(threadId || '').trim());
}

/**
 * Attach approval route metadata to thread payload on create/update.
 */
export function enrichPayloadWithApprovalRoute(payload, input = {}) {
  const base = payload && typeof payload === 'object' ? { ...payload } : {};
  const amount = Number(input.amountNgn || base.guidedForm?.estimatedCostNgn || 0);
  const route = computeOfficeApprovalRoute({
    recordType: input.recordType || base.smartMemo?.memoType,
    expenseCategory: input.expenseCategory || base.smartMemo?.expenseCategory,
    amountNgn: amount,
    requesterRoleKey: input.requesterRoleKey,
    branchId: input.branchId,
  });
  base.approvalRoute = route;
  return base;
}
